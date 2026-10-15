import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { ConflictException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantProvisioningService } from './tenant-provisioning.service';

const TEST_API_URL = process.env.TENANT_PROVISIONING_TEST_API_URL;
const TEST_AUTH_TOKEN = process.env.TENANT_PROVISIONING_AUTH_TOKEN;

interface ProvisionedUserResponse {
  accessToken: string;
  role: Role;
  userId: string;
}

describe('TenantProvisioning integration (disposable PostgreSQL)', () => {
  let prisma: PrismaClient;
  let provisioningService: TenantProvisioningService;
  const tenantIds = new Set<string>();
  const userIds = new Set<string>();

  const requestProvisioning = async (
    tenantId: string,
    provisioningKey: string,
    apiUrl = TEST_API_URL
  ) => {
    if (!apiUrl) {
      throw new Error('TENANT_PROVISIONING_TEST_API_URL must be set');
    }

    return fetch(`${apiUrl}/api/v1/internal/tenant-users`, {
      body: JSON.stringify({ tenantId, provisioningKey }),
      headers: {
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        'content-type': 'application/json'
      },
      method: 'POST'
    });
  };

  const newTenantId = () => {
    const id = randomUUID();
    tenantIds.add(id);
    return id;
  };

  const rememberUser = (userId: string) => {
    userIds.add(userId);
    return userId;
  };

  const expectConflict = async (response: Response) => {
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).not.toHaveProperty('accessToken');
  };

  const readProvisionedUser = async (
    response: Response
  ): Promise<ProvisionedUserResponse> =>
    (await response.json()) as ProvisionedUserResponse;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must point to disposable test PostgreSQL');
    }
    if (!TEST_AUTH_TOKEN || !TEST_API_URL) {
      throw new Error('Compose API URL and synthetic auth token are required');
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
    });
    await prisma.$connect();

    const configurationService = {
      get: (key: string) => {
        if (key === 'ACCESS_TOKEN_SALT') {
          return process.env.ACCESS_TOKEN_SALT;
        }
        if (key === 'TENANT_PROVISIONING_ENCRYPTION_KEY') {
          return process.env.TENANT_PROVISIONING_ENCRYPTION_KEY ?? '';
        }
        return undefined;
      }
    } as ConfigurationService;

    // Use the actual transaction-aware default initializer and token helpers;
    // only the unrelated UserService constructor dependencies are omitted.
    const userService = Object.assign(Object.create(UserService.prototype), {
      configurationService,
      i18nService: { getTranslation: () => 'My Account' }
    }) as UserService;

    provisioningService = new TenantProvisioningService(
      configurationService,
      prisma as unknown as PrismaService,
      userService
    );
  }, 120_000);

  afterEach(async () => {
    const tenants = [...tenantIds];
    const bindings = tenants.length
      ? await prisma.tenantUserProvisioning.findMany({
          where: { tenantId: { in: tenants } },
          select: { userId: true }
        })
      : [];
    const users = [
      ...new Set([...userIds, ...bindings.map(({ userId }) => userId)])
    ];
    if (tenants.length) {
      await prisma.tenantUserProvisioning.deleteMany({
        where: { tenantId: { in: tenants } }
      });
    }
    if (users.length) {
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    tenantIds.clear();
    userIds.clear();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('serializes concurrent same-key HTTP requests into one user and binding', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();

    const responses = await Promise.all([
      requestProvisioning(tenantId, provisioningKey),
      requestProvisioning(tenantId, provisioningKey)
    ]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);

    const results = await Promise.all(responses.map(readProvisionedUser));
    expect(results[0]).toEqual(results[1]);
    expect(Object.keys(results[0]).sort()).toEqual(
      ['accessToken', 'role', 'userId'].sort()
    );
    expect(results[0].role).toBe(Role.USER);
    rememberUser(results[0].userId);

    expect(
      await prisma.tenantUserProvisioning.count({ where: { tenantId } })
    ).toBe(1);
    expect(await prisma.user.count({ where: { id: results[0].userId } })).toBe(
      1
    );
    expect(
      await prisma.account.count({ where: { userId: results[0].userId } })
    ).toBe(1);
    expect(
      await prisma.settings.count({ where: { userId: results[0].userId } })
    ).toBe(1);
  }, 120_000);

  it('rolls back the user defaults if transaction initialization fails', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const functionName = 'tenant_provisioning_it_fail_account_insert';
    const triggerName = 'tenant_provisioning_it_fail_account_insert';
    const beforeCounts = await Promise.all([
      prisma.user.count(),
      prisma.account.count(),
      prisma.settings.count()
    ]);

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "Account"`
    );
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic integration failure'; END; $$`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "Account" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`
    );

    try {
      await expect(
        provisioningService.provision({ tenantId, provisioningKey })
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "Account"`
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`
      );
    }

    expect(
      await prisma.tenantUserProvisioning.count({ where: { tenantId } })
    ).toBe(0);
    expect(
      await Promise.all([
        prisma.user.count(),
        prisma.account.count(),
        prisma.settings.count()
      ])
    ).toEqual(beforeCounts);
  }, 120_000);

  it('enforces the tenant, provisioning-key, and user one-to-one constraints', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const response = await requestProvisioning(tenantId, provisioningKey);
    expect(response.status).toBe(201);
    const result = await readProvisionedUser(response);
    const boundUserId = rememberUser(result.userId);
    const anotherUserId = rememberUser(randomUUID());
    const thirdUserId = rememberUser(randomUUID());

    await prisma.user.create({ data: { id: anotherUserId } });
    await prisma.user.create({ data: { id: thirdUserId } });

    const createBinding = (data: {
      tenantId: string;
      provisioningKey: string;
      userId: string;
    }) =>
      prisma.tenantUserProvisioning.create({
        data: {
          ...data,
          encryptedAccessToken: Buffer.from('synthetic-ciphertext'),
          encryptionKeyVersion: 1
        }
      });

    await expect(
      createBinding({
        tenantId,
        provisioningKey: randomUUID(),
        userId: anotherUserId
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      createBinding({
        tenantId: newTenantId(),
        provisioningKey,
        userId: anotherUserId
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      createBinding({
        tenantId: newTenantId(),
        provisioningKey: randomUUID(),
        userId: boundUserId
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await prisma.tenantUserProvisioning.count()).toBe(1);
  }, 120_000);

  it('replays the same token and rejects drifted user state', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const firstResponse = await requestProvisioning(tenantId, provisioningKey);
    expect(firstResponse.status).toBe(201);
    const first = await readProvisionedUser(firstResponse);
    rememberUser(first.userId);

    const replayResponse = await requestProvisioning(tenantId, provisioningKey);
    expect(replayResponse.status).toBe(201);
    expect(await readProvisionedUser(replayResponse)).toEqual(first);

    await prisma.user.update({
      data: { role: Role.ADMIN },
      where: { id: first.userId }
    });
    await expectConflict(await requestProvisioning(tenantId, provisioningKey));
  }, 120_000);

  it('rejects replay if the encrypted token binding has drifted', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const response = await requestProvisioning(tenantId, provisioningKey);
    expect(response.status).toBe(201);
    const { userId } = await readProvisionedUser(response);
    rememberUser(userId);

    await prisma.tenantUserProvisioning.update({
      data: { encryptedAccessToken: Buffer.from('tampered-ciphertext') },
      where: { tenantId }
    });
    await expectConflict(await requestProvisioning(tenantId, provisioningKey));
  }, 120_000);

  it('prevents deletion of a bound user before any deletion work', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const response = await requestProvisioning(tenantId, provisioningKey);
    expect(response.status).toBe(201);
    const { userId } = await readProvisionedUser(response);
    rememberUser(userId);

    const userService = Object.assign(Object.create(UserService.prototype), {
      prismaService: prisma
    }) as UserService;

    await expect(userService.deleteUser({ id: userId })).rejects.toBeInstanceOf(
      ConflictException
    );
    await expect(
      prisma.user.delete({ where: { id: userId } })
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await prisma.user.findUnique({ where: { id: userId } })
    ).not.toBeNull();
    expect(
      await prisma.tenantUserProvisioning.findUnique({ where: { userId } })
    ).not.toBeNull();
  }, 120_000);

  it('fails closed when another API replica has the wrong encryption key', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const response = await requestProvisioning(tenantId, provisioningKey);
    expect(response.status).toBe(201);
    const { userId } = await readProvisionedUser(response);
    rememberUser(userId);

    const wrongKeyApiUrl = process.env.TENANT_PROVISIONING_WRONG_KEY_API_URL;
    expect(wrongKeyApiUrl).toBeTruthy();
    await expectConflict(
      await requestProvisioning(tenantId, provisioningKey, wrongKeyApiUrl)
    );
  }, 120_000);

  it('keeps the private route disabled when provisioner secrets are absent', async () => {
    const tenantId = newTenantId();
    const provisioningKey = randomUUID();
    const disabledApiUrl = process.env.TENANT_PROVISIONING_DISABLED_API_URL;
    expect(disabledApiUrl).toBeTruthy();

    const response = await requestProvisioning(
      tenantId,
      provisioningKey,
      disabledApiUrl
    );
    expect(response.status).toBe(404);
    expect(
      await prisma.tenantUserProvisioning.count({ where: { tenantId } })
    ).toBe(0);
  }, 120_000);
});
