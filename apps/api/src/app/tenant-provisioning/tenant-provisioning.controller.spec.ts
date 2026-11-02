import { UserModule } from '@ghostfolio/api/app/user/user.module';
import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import {
  ConflictException,
  INestApplication,
  Provider,
  ValidationPipe,
  VersioningType
} from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { TenantProvisioningAuthGuard } from './tenant-provisioning-auth.guard';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { TenantProvisioningModule } from './tenant-provisioning.module';
import { TenantProvisioningService } from './tenant-provisioning.service';

// Imported application modules use packages which Jest cannot load as ESM.
jest.mock('@openrouter/ai-sdk-provider', () => ({}));
jest.mock('ai', () => ({}));

describe('TenantProvisioningController', () => {
  const authToken = 'synthetic-controller-provisioning-secret';
  const originalAuthToken = process.env.TENANT_PROVISIONING_AUTH_TOKEN;
  const input = {
    tenantId: '0b9bd667-26e1-41cb-a6cd-09f51d085c54',
    provisioningKey: '7097b86a-1378-4fe7-aea0-1b4fb0bcd18e'
  };
  const provisionedUser = {
    userId: '00a8a912-c62f-431d-a224-f74620c6c511',
    role: 'USER',
    accessToken: 'synthetic-tenant-access-token'
  };

  let app: INestApplication;
  let provision: jest.Mock;

  async function post(
    body: unknown = input,
    authorization: string | null = `Bearer ${authToken}`
  ) {
    const server = app.getHttpServer() as Server;
    const serverAddress = server.address() as AddressInfo;
    const payload = JSON.stringify(body);

    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: serverAddress.port,
          path: '/api/v1/internal/tenant-users',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...(authorization === null ? {} : { authorization })
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            resolve({
              status: response.statusCode,
              body: JSON.parse(
                Buffer.concat(chunks).toString('utf8')
              ) as unknown
            });
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  beforeEach(async () => {
    process.env.TENANT_PROVISIONING_AUTH_TOKEN = authToken;
    provision = jest.fn().mockResolvedValue(provisionedUser);

    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TenantProvisioningModule
    ) as Provider[];
    const module = await Test.createTestingModule({
      // Reproduce the app's disabled optional global limiter. The provisioning
      // module's actual local providers must enforce its separate limit.
      imports: [
        ThrottlerModule.forRoot({
          skipIf: () => true,
          throttlers: [{ limit: 1000, ttl: 60_000 }]
        })
      ],
      controllers: [TenantProvisioningController],
      providers
    })
      .overrideProvider(TenantProvisioningService)
      .useValue({ provision })
      .compile();

    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app?.close();
    if (originalAuthToken === undefined) {
      delete process.env.TENANT_PROVISIONING_AUTH_TOKEN;
    } else {
      process.env.TENANT_PROVISIONING_AUTH_TOKEN = originalAuthToken;
    }
  });

  it('Registers the controller, service, and required service modules', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TenantProvisioningModule)
    ).toEqual([TenantProvisioningController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, TenantProvisioningModule)
    ).toEqual(
      expect.arrayContaining([ConfigurationModule, PrismaModule, UserModule])
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TenantProvisioningModule)
    ).toEqual(
      expect.arrayContaining([
        TenantProvisioningService,
        TenantProvisioningAuthGuard
      ])
    );
  });

  it('Requires dedicated provisioning authentication before rate limiting', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TenantProvisioningController)
    ).toEqual([TenantProvisioningAuthGuard, ThrottlerGuard]);
  });

  it('Exposes POST /api/v1/internal/tenant-users with the exact response contract', async () => {
    provision.mockResolvedValue({
      ...provisionedUser,
      tenantId: input.tenantId,
      provisioningKey: input.provisioningKey,
      encryptedAccessToken: 'synthetic-ciphertext',
      provider: 'ANONYMOUS'
    });

    expect(await post()).toEqual({ status: 201, body: provisionedUser });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith(input);
  });

  it.each([null, '', 'Bearer wrong-secret', `Basic ${authToken}`])(
    'Rejects unauthorized requests before invoking provisioning: %p',
    async (authorization) => {
      const response = await post(input, authorization);
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(authToken);
      expect(provision).not.toHaveBeenCalled();
    }
  );

  it('Disables the route before invoking provisioning when its auth token is unset', async () => {
    delete process.env.TENANT_PROVISIONING_AUTH_TOKEN;
    expect((await post()).status).toBe(404);
    expect(provision).not.toHaveBeenCalled();
  });

  it.each(['tenantId', 'provisioningKey'] as const)(
    'Requires a UUID for %s',
    async (field) => {
      for (const value of [
        undefined,
        null,
        '',
        'not-a-uuid',
        123,
        [],
        {},
        `${input[field]}\n`
      ]) {
        expect((await post({ ...input, [field]: value })).status).toBe(400);
      }
      expect(provision).not.toHaveBeenCalled();
    }
  );

  it.each([
    'role',
    'provider',
    'accessToken',
    'token',
    'host',
    'hostname',
    'url',
    'userId'
  ])(
    'Rejects the unsupported request property %s before provisioning',
    async (property) => {
      expect(
        (await post({ ...input, [property]: 'synthetic-forbidden-value' }))
          .status
      ).toBe(400);
      expect(provision).not.toHaveBeenCalled();
    }
  );

  it('Propagates the service sanitized conflict response', async () => {
    provision.mockRejectedValue(
      new ConflictException('Tenant provisioning conflict')
    );
    expect(await post()).toEqual({
      status: 409,
      body: {
        message: 'Tenant provisioning conflict',
        error: 'Conflict',
        statusCode: 409
      }
    });
  });

  it('Limits requests to 10 per minute even when optional global limiting is disabled', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await post()).status).toBe(201);
    }
    const response = await post();
    expect(response.status).toBe(429);
    expect(provision).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(response.body)).not.toContain(authToken);
  });

  it('Does not let rejected authentication consume the authenticated callers rate limit', async () => {
    for (let attempt = 0; attempt < 11; attempt++) {
      expect((await post(input, 'Bearer wrong-secret')).status).toBe(401);
    }
    expect((await post()).status).toBe(201);
    expect(provision).toHaveBeenCalledTimes(1);
  });
});
