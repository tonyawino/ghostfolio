import {
  createAccountRequestDigest,
  parseIdempotencyKey
} from './account-idempotency';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

const KEY = '123e4567-e89b-42d3-a456-426614174000';
const USER = 'user-id';
const DATA = {
  name: 'Cash',
  currency: 'USD',
  user: { connect: { id: USER } }
} as any;

function makeService(prisma: any, emitter = { emit: jest.fn() }) {
  const service = Object.assign(Object.create(AccountService.prototype), {
    prismaService: prisma,
    tagService: { validateTagIdsWithoutDraftTag: jest.fn() },
    eventEmitter: emitter
  }) as AccountService;
  return { service, emitter };
}

describe('account create idempotency', () => {
  it('accepts exactly one UUID key', () => {
    const key = '123e4567-e89b-42d3-a456-426614174000';
    expect(parseIdempotencyKey(key)).toBe(key);
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(() => parseIdempotencyKey(`${key},${key}`)).toThrow();
    expect(() => parseIdempotencyKey('not-a-uuid')).toThrow();
  });

  it('hashes normalized validated fields and ignores tag ordering', () => {
    const base = {
      name: 'Cash',
      currency: 'USD',
      balance: 0,
      platformId: null,
      tagIds: ['b', 'a'],
      comment: null,
      id: null
    };
    expect(createAccountRequestDigest(base)).toBe(
      createAccountRequestDigest({ ...base, tagIds: ['a', 'b'] })
    );
    for (const changed of [
      { ...base, name: 'Other' },
      { ...base, currency: 'EUR' },
      { ...base, balance: 1 },
      { ...base, platformId: 'platform' },
      { ...base, tagIds: ['a'] },
      { ...base, comment: 'note' },
      { ...base, id: 'explicit-id' }
    ]) {
      expect(createAccountRequestDigest(changed)).not.toBe(
        createAccountRequestDigest(base)
      );
    }
  });

  it('routes keyed requests using the authenticated user and validated body', async () => {
    const createAccountIdempotently = jest.fn().mockResolvedValue({ id: 'a' });
    const controller = new AccountController(
      {} as any,
      { createAccountIdempotently } as any,
      {} as any,
      {} as any
    );
    const data = {
      name: 'Cash',
      currency: 'USD',
      platformId: null,
      id: 'given-id'
    } as any;
    await controller.createAccount(
      data,
      { userId: 'trusted-user' } as any,
      '123e4567-e89b-42d3-a456-426614174000'
    );
    expect(createAccountIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'trusted-user',
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
        data: expect.objectContaining({
          id: 'given-id',
          user: { connect: { id: 'trusted-user' } }
        })
      })
    );
  });

  it('preserves the legacy service path when no key is supplied', async () => {
    const createAccount = jest.fn().mockResolvedValue({ id: 'legacy' });
    const createAccountIdempotently = jest.fn();
    const controller = new AccountController(
      {} as any,
      { createAccount, createAccountIdempotently } as any,
      {} as any,
      {} as any
    );
    await controller.createAccount(
      { name: 'Cash', currency: 'USD', platformId: null } as any,
      { userId: USER } as any
    );
    expect(createAccount).toHaveBeenCalledTimes(1);
    expect(createAccountIdempotently).not.toHaveBeenCalled();
  });

  it('rejects a malformed key before either create service is invoked', async () => {
    const createAccount = jest.fn();
    const createAccountIdempotently = jest.fn();
    const controller = new AccountController(
      {} as any,
      { createAccount, createAccountIdempotently } as any,
      {} as any,
      {} as any
    );
    await expect(
      controller.createAccount(
        { name: 'Cash', currency: 'USD', platformId: null } as any,
        { userId: USER } as any,
        'bad-key'
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(createAccount).not.toHaveBeenCalled();
    expect(createAccountIdempotently).not.toHaveBeenCalled();
  });

  it('rejects a changed body with a static conflict', async () => {
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue({
          requestDigest: 'different',
          resultAccountId: 'a'
        })
      },
      account: { findUnique: jest.fn() },
      $transaction: jest.fn()
    };
    const { service } = makeService(prisma);
    await expect(
      service.createAccountIdempotently({
        data: DATA,
        userId: USER,
        idempotencyKey: KEY
      })
    ).rejects.toMatchObject({ status: 409, response: 'Conflict' });
    expect(prisma.account.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['comment', 'first note', 'second note'],
    ['id', 'first-id', 'second-id']
  ])(
    'conflicts when the %s field changes on a replay',
    async (field, first, second) => {
      const changedData = { ...DATA, [field]: second };
      const persistedDigest = createAccountRequestDigest({
        id: field === 'id' ? first : null,
        name: 'Cash',
        currency: 'USD',
        comment: field === 'comment' ? first : null
      });
      const prisma = {
        accountCreateIdempotency: {
          findUnique: jest.fn().mockResolvedValue({
            requestDigest: persistedDigest,
            resultAccountId: 'a'
          })
        },
        account: { findUnique: jest.fn() },
        $transaction: jest.fn()
      };
      const { service } = makeService(prisma);
      await expect(
        service.createAccountIdempotently({
          data: changedData,
          userId: USER,
          idempotencyKey: KEY
        })
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  );

  it('scopes lookup to authenticated USER and preserves a deleted result as a tombstone', async () => {
    const digest = createAccountRequestDigest({
      name: 'Cash',
      currency: 'USD'
    });
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue({
          requestDigest: digest,
          resultAccountId: 'deleted'
        })
      },
      account: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn()
    };
    const { service } = makeService(prisma);
    await expect(
      service.createAccountIdempotently({
        data: DATA,
        userId: USER,
        idempotencyKey: KEY
      })
    ).rejects.toMatchObject({ status: 410, response: 'Gone' });
    expect(
      (service as any).tagService.validateTagIdsWithoutDraftTag
    ).not.toHaveBeenCalled();
    expect(prisma.accountCreateIdempotency.findUnique).toHaveBeenCalledWith({
      where: {
        userId_operation_key: {
          userId: USER,
          operation: 'account.create',
          key: KEY
        }
      }
    });
    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { id_userId: { id: 'deleted', userId: USER } }
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows the same key independently for different authenticated users', async () => {
    const resultRows: any[] = [];
    const tx = {
      account: {
        create: jest.fn(async ({ data }: any) => ({
          id: `account-${data.user.connect.id}`,
          userId: data.user.connect.id
        }))
      },
      accountBalance: { create: jest.fn() },
      accountCreateIdempotency: {
        create: jest.fn(async ({ data }: any) => {
          resultRows.push(data);
          return data;
        })
      }
    };
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn(async (callback: (tx: any) => any) => callback(tx))
    };
    const { service } = makeService(prisma);
    for (const userId of ['user-one', 'user-two']) {
      await service.createAccountIdempotently({
        data: {
          name: 'Cash',
          currency: 'USD',
          user: { connect: { id: userId } }
        },
        userId,
        idempotencyKey: KEY
      });
    }
    expect(resultRows.map(({ userId, key }) => ({ userId, key }))).toEqual([
      { userId: 'user-one', key: KEY },
      { userId: 'user-two', key: KEY }
    ]);
    expect(tx.account.create).toHaveBeenCalledTimes(2);
  });

  it('validates new request tags inside the create transaction before inserting the account', async () => {
    const events: string[] = [];
    const transaction = {
      tag: {
        count: jest.fn(async () => {
          events.push('validate-tags');
          return 1;
        })
      },
      account: {
        create: jest.fn(async () => {
          events.push('create-account');
          return { id: 'new-account', userId: USER };
        })
      },
      accountCreateIdempotency: {
        create: jest.fn(async () => {
          events.push('create-result');
          return {};
        })
      },
      accountBalance: { create: jest.fn() }
    };
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn((callback: (tx: any) => any) =>
        callback(transaction)
      )
    };
    const { service } = makeService(prisma);
    await service.createAccountIdempotently({
      data: DATA,
      tagIds: ['tag-one'],
      userId: USER,
      idempotencyKey: KEY
    });
    expect(events).toEqual([
      'validate-tags',
      'create-account',
      'create-result'
    ]);
    expect(transaction.tag.count).toHaveBeenCalledWith({
      where: {
        id: { in: ['tag-one'] },
        OR: [{ userId: USER }, { userId: null }]
      }
    });
    expect(
      (service as any).tagService.validateTagIdsWithoutDraftTag
    ).not.toHaveBeenCalled();
  });

  it('recovers a concurrent unique-key winner and emits only after the transaction settles', async () => {
    const digest = createAccountRequestDigest({
      name: 'Cash',
      currency: 'USD'
    });
    const account = { id: 'winner', userId: USER };
    const order: string[] = [];
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            requestDigest: digest,
            resultAccountId: 'winner'
          })
      },
      account: { findUnique: jest.fn().mockResolvedValue(account) },
      $transaction: jest.fn().mockRejectedValue({ code: 'P2002' })
    };
    const emitter = { emit: jest.fn(() => order.push('event')) };
    prisma.$transaction.mockImplementation(async () => {
      order.push('transaction');
      throw { code: 'P2002' };
    });
    const { service } = makeService(prisma, emitter);
    await expect(
      service.createAccountIdempotently({
        data: DATA,
        userId: USER,
        idempotencyKey: KEY
      })
    ).resolves.toBe(account);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['transaction', 'event']);
  });

  it('does not emit an event when the atomic transaction fails', async () => {
    const failure = new Error('write failed');
    const transaction = {
      account: {
        create: jest.fn().mockResolvedValue({ id: 'new', userId: USER })
      },
      accountBalance: { create: jest.fn().mockResolvedValue({}) },
      accountCreateIdempotency: { create: jest.fn().mockRejectedValue(failure) }
    };
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn(async (callback: (tx: any) => any) =>
        callback(transaction)
      )
    };
    const { service, emitter } = makeService(prisma);
    await expect(
      service.createAccountIdempotently({
        data: DATA,
        balance: 3,
        userId: USER,
        idempotencyKey: KEY
      })
    ).rejects.toBe(failure);
    expect(transaction.account.create).toHaveBeenCalledTimes(1);
    expect(transaction.accountBalance.create).toHaveBeenCalledTimes(1);
    expect(transaction.accountCreateIdempotency.create).toHaveBeenCalledTimes(
      1
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('returns the original account for a replay without writing a second account or balance', async () => {
    const account = { id: 'account-id', userId: 'user-id' } as any;
    const prisma = {
      accountCreateIdempotency: {
        findUnique: jest.fn().mockResolvedValue({
          requestDigest: createAccountRequestDigest({
            name: 'Cash',
            currency: 'USD',
            balance: 5
          }),
          resultAccountId: account.id
        }),
        create: jest.fn()
      },
      account: {
        findUnique: jest.fn().mockResolvedValue(account),
        create: jest.fn()
      },
      accountBalance: { create: jest.fn() },
      $transaction: jest.fn()
    };
    const emitter = { emit: jest.fn() };
    const service = Object.assign(Object.create(AccountService.prototype), {
      prismaService: prisma,
      tagService: { validateTagIdsWithoutDraftTag: jest.fn() },
      eventEmitter: emitter
    }) as AccountService;

    const result = await service.createAccountIdempotently({
      data: {
        name: 'Cash',
        currency: 'USD',
        user: { connect: { id: 'user-id' } }
      },
      balance: 5,
      userId: 'user-id',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000'
    });

    expect(result).toBe(account);
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.accountBalance.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
