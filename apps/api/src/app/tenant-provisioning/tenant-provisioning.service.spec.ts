import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { TenantProvisioningService } from './tenant-provisioning.service';

const TENANT_ID = '8a1f3384-b8c1-4d56-a5c6-a1168a6498ab';
const PROVISIONING_KEY = 'b4b1783d-9ac2-449e-8d6a-f9e8ebdb4df8';
const OTHER_TENANT_ID = '1bb4e05a-3d0c-40b8-a226-8ddc9e8c3e67';
const OTHER_PROVISIONING_KEY = '9eac4cb1-8458-4e49-9486-14df1551eea6';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const ACCESS_TOKEN_SALT = 'synthetic-access-token-salt';

describe('TenantProvisioningService', () => {
  let service: TenantProvisioningService;
  let prismaService: any;
  let userService: any;
  let configurationService: any;
  let bindings: any[];
  let users: any[];
  let failNextBindingCreate: boolean;
  let bindingCreateError: Error | undefined;
  let committedRaceWinner: { bindings: any[]; users: any[] } | undefined;

  beforeEach(() => {
    bindings = [];
    users = [];
    failNextBindingCreate = false;
    bindingCreateError = undefined;
    committedRaceWinner = undefined;

    const transaction = {
      tenantUserProvisioning: {
        create: jest.fn(async ({ data }) => {
          if (bindingCreateError) {
            const error = bindingCreateError;
            bindingCreateError = undefined;
            throw error;
          }

          if (failNextBindingCreate) {
            failNextBindingCreate = false;
            const error: any = new Error('private prisma details');
            error.code = 'P2002';
            throw error;
          }

          if (
            bindings.some(
              (binding) =>
                binding.tenantId === data.tenantId ||
                binding.provisioningKey === data.provisioningKey ||
                binding.userId === data.userId
            )
          ) {
            const error: any = new Error('private prisma details');
            error.code = 'P2002';
            throw error;
          }

          bindings.push(data);
          return data;
        }),
        findFirst: jest.fn(async ({ where }) => {
          const binding = bindings.find((binding) =>
            where.OR.some(
              (condition) =>
                (!condition.tenantId ||
                  binding.tenantId === condition.tenantId) &&
                (!condition.provisioningKey ||
                  binding.provisioningKey === condition.provisioningKey)
            )
          );

          return binding
            ? {
                ...binding,
                user: users.find((user) => user.id === binding.userId) ?? null
              }
            : null;
        })
      },
      user: {
        findUnique: jest.fn(async ({ where }) => {
          return users.find((user) => user.id === where.id) ?? null;
        })
      }
    };

    prismaService = {
      $transaction: jest.fn(async (callback) => {
        const bindingSnapshot = [...bindings];
        const userSnapshot = [...users];
        try {
          return await callback(transaction);
        } catch (error) {
          bindings = bindingSnapshot;
          users = userSnapshot;
          if (committedRaceWinner) {
            bindings = committedRaceWinner.bindings;
            users = committedRaceWinner.users;
            committedRaceWinner = undefined;
          }
          throw error;
        }
      }),
      tenantUserProvisioning: transaction.tenantUserProvisioning
    };
    userService = {
      createAccessToken: ({ password, salt }) =>
        createHmac('sha512', salt).update(password).digest('hex'),
      generateAccessToken: jest.fn(({ userId }) => {
        const accessToken = `synthetic-token-${userId}`;
        return {
          accessToken,
          hashedAccessToken: createHmac('sha512', ACCESS_TOKEN_SALT)
            .update(accessToken)
            .digest('hex')
        };
      }),
      createUserWithDefaults: jest.fn(async (_transaction, data) => {
        const user = { ...data };
        users.push(user);
        return user;
      })
    };
    configurationService = {
      get: jest.fn((key: string) => {
        if (key === 'TENANT_PROVISIONING_ENCRYPTION_KEY') {
          return ENCRYPTION_KEY;
        }
        if (key === 'ACCESS_TOKEN_SALT') {
          return ACCESS_TOKEN_SALT;
        }
        return undefined;
      })
    };

    service = new TenantProvisioningService(
      configurationService as ConfigurationService,
      prismaService as PrismaService,
      userService as UserService
    );
  });

  it('creates an anonymous USER and returns its recoverable access token', async () => {
    const result = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    expect(result).toEqual({
      userId: expect.any(String),
      role: Role.USER,
      accessToken: expect.stringMatching(/^synthetic-token-/)
    });
    expect(userService.createUserWithDefaults).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: Provider.ANONYMOUS,
        role: Role.USER,
        accessToken: expect.any(String)
      }),
      undefined
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY,
        userId: result.userId,
        encryptionKeyVersion: 1,
        encryptedAccessToken: expect.any(Uint8Array)
      })
    );
    expect(bindings[0].encryptedAccessToken.toString()).not.toContain(
      result.accessToken
    );
    expect(users[0].accessToken).not.toBe(result.accessToken);
    expect(userService.generateAccessToken).toHaveBeenCalledWith({
      userId: result.userId
    });
  });

  it('replays the same tenant/key with the same user and token', async () => {
    const first = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    const second = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    expect(second).toEqual(first);
    expect(users).toHaveLength(1);
    expect(bindings).toHaveLength(1);
    expect(userService.createUserWithDefaults).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes mixed-case UUIDs for lookup, storage, and replay', async () => {
    const first = await service.provision({
      tenantId: TENANT_ID.toUpperCase(),
      provisioningKey: PROVISIONING_KEY.toUpperCase()
    });
    const replay = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    expect(replay).toEqual(first);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    );
    expect(userService.createUserWithDefaults).toHaveBeenCalledTimes(1);
  });

  it.each([
    [TENANT_ID, OTHER_PROVISIONING_KEY],
    [OTHER_TENANT_ID, PROVISIONING_KEY]
  ])(
    'rejects a mismatched tenant/key binding (%s, %s)',
    async (tenantId, key) => {
      await service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      });

      await expect(
        service.provision({ tenantId, provisioningKey: key })
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users).toHaveLength(1);
      expect(bindings).toHaveLength(1);
    }
  );

  it('never promotes the first provisioned user to ADMIN', async () => {
    const result = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    expect(users[0].role).toBe(Role.USER);
    expect(users[0].provider).toBe(Provider.ANONYMOUS);
    expect(result.role).toBe(Role.USER);
  });

  it.each([
    ['trailing non-hex character', (verifier: string) => `${verifier}g`],
    ['odd trailing nibble', (verifier: string) => verifier.slice(0, -1)]
  ])('rejects a verifier with %s', async (_description, corruptVerifier) => {
    await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    users[0].accessToken = corruptVerifier(users[0].accessToken);

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toMatchObject({
      response: { message: 'Tenant provisioning conflict' }
    });
  });

  it('rolls back the user and binding when initialization fails', async () => {
    userService.createUserWithDefaults.mockRejectedValueOnce(
      new Error('synthetic initialization failure')
    );

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toThrow();
    expect(users).toHaveLength(0);
    expect(bindings).toHaveLength(0);
  });

  it.each([undefined, 'invalid-key'])(
    'fails closed before opening a transaction when encryption key is %p',
    async (encryptionKey) => {
      configurationService.get.mockImplementation((key: string) => {
        if (key === 'ACCESS_TOKEN_SALT') {
          return ACCESS_TOKEN_SALT;
        }
        return encryptionKey;
      });

      await expect(
        service.provision({
          tenantId: TENANT_ID,
          provisioningKey: PROVISIONING_KEY
        })
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    { role: Role.ADMIN, provider: Provider.ANONYMOUS },
    { role: Role.USER, provider: Provider.GOOGLE },
    { role: Role.USER, provider: Provider.ANONYMOUS, accessToken: 'rotated' }
  ])('does not reveal a token after provisioned user drift', async (drift) => {
    const result = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    Object.assign(users[0], drift);

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toMatchObject({
      response: { message: 'Tenant provisioning conflict' }
    });
    expect(result.accessToken).toBeDefined();
  });

  it('rejects a tampered encrypted token with a sanitized conflict', async () => {
    const result = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    const corruptedEnvelope = new Uint8Array(bindings[0].encryptedAccessToken);
    corruptedEnvelope[0] = (corruptedEnvelope[0] + 1) % 256;
    bindings[0].encryptedAccessToken = corruptedEnvelope;

    const error = await service
      .provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      message: 'Tenant provisioning conflict'
    });
    expect(JSON.stringify(error)).not.toContain(result.accessToken);
  });

  it('does not decrypt a replay with a different valid encryption key', async () => {
    await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    configurationService.get.mockImplementation((key: string) => {
      if (key === 'TENANT_PROVISIONING_ENCRYPTION_KEY') {
        return Buffer.alloc(32, 9).toString('base64');
      }
      if (key === 'ACCESS_TOKEN_SALT') {
        return ACCESS_TOKEN_SALT;
      }
      return undefined;
    });

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects replay when the mapped user no longer exists', async () => {
    await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    users = [];

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rolls back user creation when the binding write fails', async () => {
    bindingCreateError = new Error('private database error');

    await expect(
      service.provision({
        tenantId: TENANT_ID,
        provisioningKey: PROVISIONING_KEY
      })
    ).rejects.toMatchObject({
      response: { message: 'Tenant provisioning failed' }
    });
    expect(users).toHaveLength(0);
    expect(bindings).toHaveLength(0);
  });

  it('sanitizes database failures without returning identifiers or token data', async () => {
    prismaService.$transaction.mockRejectedValueOnce(
      new Error('private database error with secret token')
    );

    const rejection = service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    await expect(rejection).rejects.toMatchObject({
      response: { message: 'Tenant provisioning failed' }
    });
    expect(bindings).toHaveLength(0);
    expect(users).toHaveLength(0);
  });

  it('recovers the committed winning binding after a unique-key race', async () => {
    const winner = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });
    committedRaceWinner = {
      bindings: [...bindings],
      users: [...users]
    };
    bindings = [];
    users = [];
    failNextBindingCreate = true;

    const replayedWinner = await service.provision({
      tenantId: TENANT_ID,
      provisioningKey: PROVISIONING_KEY
    });

    expect(replayedWinner).toEqual(winner);
    expect(bindings).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(userService.createUserWithDefaults).toHaveBeenCalledTimes(2);
  });
});
