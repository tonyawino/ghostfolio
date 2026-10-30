import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AccountService } from './account.service';

const databaseUrl = process.env.ACCOUNT_IDEMPOTENCY_TEST_DATABASE_URL;
const runPostgresTests = Boolean(databaseUrl);
const postgresDescribe = runPostgresTests ? describe : describe.skip;

postgresDescribe('account create idempotency (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let service: AccountService;
  let userId: string;
  const eventEmitter = { emit: jest.fn() };

  beforeAll(async () => {
    const url = new URL(databaseUrl as string);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.pathname.includes('gf_account_idempotency_test')
    ) {
      throw new Error(
        'PostgreSQL integration tests require the disposable local test database'
      );
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString() })
    });
    await prisma.$connect();
    const user = await prisma.user.create({ data: {} });
    userId = user.id;
    const prismaService = {
      account: prisma.account,
      accountBalance: prisma.accountBalance,
      accountCreateIdempotency: prisma.accountCreateIdempotency,
      $transaction: prisma.$transaction.bind(prisma)
    };
    service = Object.assign(Object.create(AccountService.prototype), {
      prismaService,
      tagService: { validateTagIdsWithoutDraftTag: jest.fn() },
      eventEmitter
    }) as AccountService;
  });

  afterAll(async () => {
    if (!prisma) return;
    if (userId) {
      await prisma.accountCreateIdempotency.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  function request(
    key: string,
    id?: string,
    balance = 12.5,
    tagIds?: string[]
  ) {
    return service.createAccountIdempotently({
      data: {
        ...(id ? { id } : {}),
        name: `Synthetic ${key}`,
        currency: 'USD',
        user: { connect: { id: userId } }
      },
      balance,
      tagIds,
      userId,
      idempotencyKey: key
    });
  }

  it('converges concurrent same-key requests to one account, balance and result', async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([request(key), request(key)]);

    expect(first.id).toEqual(expect.any(String));
    expect(second.id).toBe(first.id);
    expect(
      await prisma.account.count({ where: { id: first.id, userId } })
    ).toBe(1);
    expect(
      await prisma.accountBalance.count({
        where: { accountId: first.id, userId }
      })
    ).toBe(1);
    expect(
      await prisma.accountCreateIdempotency.count({
        where: { userId, operation: 'account.create', key }
      })
    ).toBe(1);
  });

  it('rolls back the account and balance when the idempotency insert fails', async () => {
    const key = randomUUID();
    const accountId = randomUUID();
    const failingService = Object.assign(
      Object.create(AccountService.prototype),
      {
        prismaService: {
          account: prisma.account,
          accountBalance: prisma.accountBalance,
          accountCreateIdempotency: prisma.accountCreateIdempotency,
          $transaction: (
            callback: (transaction: unknown) => Promise<unknown>
          ) =>
            prisma.$transaction((transaction) =>
              callback(
                new Proxy(transaction, {
                  get(target, property, receiver) {
                    if (property === 'accountCreateIdempotency') {
                      return {
                        create: async () => {
                          throw new Error('synthetic insertion failure');
                        }
                      };
                    }
                    return Reflect.get(target, property, receiver);
                  }
                })
              )
            )
        },
        tagService: { validateTagIdsWithoutDraftTag: jest.fn() },
        eventEmitter
      }
    ) as AccountService;

    await expect(
      failingService.createAccountIdempotently({
        data: {
          id: accountId,
          name: `Synthetic ${accountId}`,
          currency: 'USD',
          user: { connect: { id: userId } }
        },
        balance: 9,
        userId,
        idempotencyKey: key
      })
    ).rejects.toThrow('synthetic insertion failure');

    expect(
      await prisma.account.count({ where: { id: accountId, userId } })
    ).toBe(0);
    expect(
      await prisma.accountBalance.count({ where: { accountId, userId } })
    ).toBe(0);
    expect(
      await prisma.accountCreateIdempotency.count({
        where: { userId, operation: 'account.create', key }
      })
    ).toBe(0);
  });

  it('keeps the key tombstone after account deletion and never recreates it', async () => {
    const key = randomUUID();
    const accountId = randomUUID();
    await request(key, accountId, 4);
    await prisma.account.delete({
      where: { id_userId: { id: accountId, userId } }
    });

    await expect(request(key, accountId, 4)).rejects.toMatchObject({
      status: 410
    });
    expect(
      await prisma.account.count({ where: { id: accountId, userId } })
    ).toBe(0);
    expect(
      await prisma.accountBalance.count({ where: { accountId, userId } })
    ).toBe(0);
    expect(
      await prisma.accountCreateIdempotency.count({
        where: { userId, operation: 'account.create', key }
      })
    ).toBe(1);
  });

  it('replays successfully when a request tag is deleted after account creation', async () => {
    const key = randomUUID();
    const accountId = randomUUID();
    const tag = await prisma.tag.create({
      data: { id: randomUUID(), name: `Synthetic tag ${key}`, userId }
    });
    const original = await request(key, accountId, 4, [tag.id]);
    await prisma.tag.delete({ where: { id: tag.id } });

    const replay = await request(key, accountId, 4, [tag.id]);
    expect(replay.id).toBe(original.id);
    expect(
      await prisma.account.count({ where: { id: accountId, userId } })
    ).toBe(1);
    expect(
      await prisma.accountBalance.count({ where: { accountId, userId } })
    ).toBe(1);
    expect(
      await prisma.accountCreateIdempotency.count({
        where: { userId, operation: 'account.create', key }
      })
    ).toBe(1);
  });
});
