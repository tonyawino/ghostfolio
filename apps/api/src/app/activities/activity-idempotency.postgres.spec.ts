import { AccountBalanceService } from '@ghostfolio/api/app/account-balance/account-balance.service';
import { AccountService } from '@ghostfolio/api/app/account/account.service';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { ActivitiesService } from './activities.service';
import { ActivityCreateInput } from './activity-idempotency';

const databaseUrl = process.env.ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('activity create idempotency (disposable PostgreSQL)', () => {
  let prisma: PrismaClient;
  let userId: string;
  let otherUserId: string;
  let accountId: string;
  const symbol = `SYNTH-${randomUUID()}`;
  const eventEmitter = { emit: jest.fn() };
  const gathering = { addJobToQueue: jest.fn().mockResolvedValue(undefined) };
  const exchange = {
    toCurrencyAtDate: jest.fn(async (amount: number) => amount)
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/gf_activity_idempotency_test'
    ) {
      throw new Error(
        'Only the named disposable local activity idempotency test database is allowed'
      );
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl })
    });
    await prisma.$connect();
    userId = (await prisma.user.create({ data: {} })).id;
    otherUserId = (await prisma.user.create({ data: {} })).id;
    accountId = (
      await prisma.account.create({
        data: { name: 'Synthetic account', currency: 'USD', userId }
      })
    ).id;
    await prisma.symbolProfile.create({
      data: { dataSource: 'YAHOO', symbol, currency: 'USD' }
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.activityCreateIdempotency.deleteMany({
      where: { userId: { in: [userId, otherUserId] } }
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherUserId] } }
    });
    await prisma.symbolProfile.deleteMany({ where: { symbol } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function service(database: PrismaClient = prisma): ActivitiesService {
    const balances = Object.assign(
      Object.create(AccountBalanceService.prototype),
      { prismaService: database, eventEmitter }
    );
    const accounts = Object.assign(Object.create(AccountService.prototype), {
      prismaService: database,
      accountBalanceService: balances,
      eventEmitter,
      exchangeRateDataService: exchange
    });
    return Object.assign(Object.create(ActivitiesService.prototype), {
      prismaService: database,
      accountService: accounts,
      eventEmitter,
      dataGatheringService: gathering,
      tagService: { validateTagIds: jest.fn().mockResolvedValue(undefined) }
    });
  }

  function input(
    overrides: Partial<ActivityCreateInput> = {}
  ): ActivityCreateInput {
    return {
      accountId,
      userId,
      date: new Date('2026-01-01'),
      type: 'BUY',
      quantity: 2,
      unitPrice: 3,
      fee: 1,
      currency: 'USD',
      updateAccountBalance: true,
      user: { connect: { id: userId } },
      SymbolProfile: {
        connectOrCreate: {
          create: { dataSource: 'YAHOO', symbol, currency: 'USD' },
          where: { dataSource_symbol: { dataSource: 'YAHOO', symbol } }
        }
      },
      ...overrides
    };
  }
  const options = (key: string, actor = userId) => ({
    idempotencyKey: key,
    authenticatedUserId: actor
  });
  async function balance() {
    return (
      (
        await prisma.accountBalance.findFirst({
          where: { accountId },
          orderBy: { date: 'desc' }
        })
      )?.value ?? 0
    );
  }

  it('converges concurrent duplicate creates to one Order, result and balance effect', async () => {
    const key = randomUUID();
    const before = await balance();
    let releaseValidation: () => void;
    const validationsReady = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const firstValidation = jest.fn(async () => {
      if (firstValidation.mock.calls.length === 4) releaseValidation();
      await validationsReady;
    });
    const s = service();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.createActivityIdempotently(input(), {
          ...options(key),
          beforeCreate: firstValidation
        })
      )
    );
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(await prisma.order.count({ where: { id: results[0].id } })).toBe(1);
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(1);
    expect(await balance()).toBe(before - 7);
    expect(firstValidation).toHaveBeenCalledTimes(4);
    expect(gathering.addJobToQueue).toHaveBeenCalledTimes(4);
  });

  it('returns a concurrent committed winner when provider validation fails outside the transaction', async () => {
    const key = randomUUID();
    const before = await balance();
    let winnerId: string;
    const replay = await service().createActivityIdempotently(input(), {
      ...options(key),
      beforeCreate: async () => {
        const winner = await service().createActivityIdempotently(
          input(),
          options(key)
        );
        winnerId = winner.id;
        throw new Error('synthetic quota change during provider validation');
      }
    });
    expect(replay.id).toBe(winnerId);
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(1);
    expect(await balance()).toBe(before - 7);
    expect(gathering.addJobToQueue).toHaveBeenCalledTimes(2);
  });

  it('waits for an uncommitted same-key winner when sibling provider validation rejects', async () => {
    const key = randomUUID();
    const before = await balance();
    let markStaged: () => void;
    let releaseWinner: () => void;
    let markRecoveryAttempted: () => void;
    const staged = new Promise<void>((resolve) => {
      markStaged = resolve;
    });
    const winnerReleased = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const recoveryAttempted = new Promise<void>((resolve) => {
      markRecoveryAttempted = resolve;
    });
    const winnerDatabase = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction')
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>
          ) =>
            prisma.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p === 'activityCreateIdempotency')
                      return {
                        findUnique:
                          tx.activityCreateIdempotency.findUnique.bind(
                            tx.activityCreateIdempotency
                          ),
                        create: async (
                          args: Prisma.ActivityCreateIdempotencyCreateArgs
                        ) => {
                          const result =
                            await tx.activityCreateIdempotency.create(args);
                          markStaged();
                          await winnerReleased;
                          return result;
                        }
                      };
                    return Reflect.get(t, p, r);
                  }
                })
              )
            );
        return Reflect.get(target, property, receiver);
      }
    });
    let lookups = 0;
    const siblingDatabase = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction')
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>
          ) => {
            markRecoveryAttempted();
            return prisma.$transaction(callback);
          };
        if (property === 'activityCreateIdempotency')
          return {
            findUnique: async (
              args: Prisma.ActivityCreateIdempotencyFindUniqueArgs
            ) => {
              const result =
                await prisma.activityCreateIdempotency.findUnique(args);
              if (++lookups === 2) markRecoveryAttempted();
              return result;
            }
          };
        return Reflect.get(target, property, receiver);
      }
    });
    const winner = service(winnerDatabase).createActivityIdempotently(
      input(),
      options(key)
    );
    await staged;
    const siblingOutcome = service(siblingDatabase)
      .createActivityIdempotently(input(), {
        ...options(key),
        beforeCreate: async () => {
          throw new Error('synthetic provider rejection');
        }
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    try {
      await recoveryAttempted;
    } finally {
      releaseWinner();
    }
    const [created, outcome] = await Promise.all([winner, siblingOutcome]);
    expect(outcome).toMatchObject({ result: { id: created.id } });
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(1);
    expect(await balance()).toBe(before - 7);
  });

  it('serializes balance changes across different keys without losing an increment', async () => {
    const before = await balance();
    await Promise.all([
      service().createActivityIdempotently(input(), options(randomUUID())),
      service().createActivityIdempotently(input(), options(randomUUID()))
    ]);
    expect(await balance()).toBe(before - 14);
  });

  it('rolls back Order, nested profile/tags and balance if inserting the result fails', async () => {
    const key = randomUUID();
    const orderId = randomUUID();
    const before = await balance();
    const tag = await prisma.tag.create({
      data: { name: 'Synthetic activity tag', userId }
    });
    const failingDatabase = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction')
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>
          ) =>
            prisma.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p === 'activityCreateIdempotency')
                      return {
                        findUnique:
                          tx.activityCreateIdempotency.findUnique.bind(
                            tx.activityCreateIdempotency
                          ),
                        create: async () => {
                          throw new Error('synthetic result insertion failure');
                        }
                      };
                    return Reflect.get(t, p, r);
                  }
                })
              )
            );
        return Reflect.get(target, property, receiver);
      }
    });
    await expect(
      service(failingDatabase).createActivityIdempotently(
        input({ id: orderId, type: 'FEE', tags: [{ id: tag.id }] }),
        options(key)
      )
    ).rejects.toThrow('synthetic result insertion failure');
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(0);
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(0);
    expect(
      await prisma.symbolProfile.count({ where: { userId, name: symbol } })
    ).toBe(0);
    expect(
      await prisma.tag.findUnique({
        where: { id: tag.id },
        include: { activities: true }
      })
    ).toMatchObject({ activities: [] });
    expect(await balance()).toBe(before);
    expect(gathering.addJobToQueue).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rolls back when requested balance conversion is unavailable and permits a safe retry', async () => {
    const key = randomUUID();
    const before = await balance();
    const count = await prisma.order.count({ where: { userId } });
    exchange.toCurrencyAtDate.mockResolvedValueOnce(undefined);
    await expect(
      service().createActivityIdempotently(input(), options(key))
    ).rejects.toThrow('Unable to convert account balance amount');
    expect(await prisma.order.count({ where: { userId } })).toBe(count);
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(0);
    expect(await balance()).toBe(before);
    expect(gathering.addJobToQueue).not.toHaveBeenCalled();
    await service().createActivityIdempotently(input(), options(key));
    expect(await balance()).toBe(before - 7);
  });

  it('returns 409 on digest mismatch without changing the original or balance', async () => {
    const key = randomUUID();
    const original = await service().createActivityIdempotently(
      input(),
      options(key)
    );
    const before = await balance();
    await expect(
      service().createActivityIdempotently(input({ quantity: 3 }), options(key))
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.order.count({ where: { id: original.id } })).toBe(1);
    expect(await balance()).toBe(before);
  });

  it('isolates the same key across authenticated users and binds the owner', async () => {
    const key = randomUUID();
    const a = await service().createActivityIdempotently(input(), options(key));
    const b = await service().createActivityIdempotently(
      input({
        accountId: undefined,
        userId: otherUserId,
        user: { connect: { id: otherUserId } }
      }),
      options(key, otherUserId)
    );
    expect(a.id).not.toBe(b.id);
    expect(
      await prisma.activityCreateIdempotency.count({ where: { key } })
    ).toBe(2);
    await expect(
      service().createActivityIdempotently(
        input({ userId: otherUserId, user: { connect: { id: otherUserId } } }),
        options(key)
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('replays after quota/tag changes without another balance effect', async () => {
    const key = randomUUID();
    const tag = await prisma.tag.create({
      data: { name: 'Synthetic transient tag', userId }
    });
    const request = input({ tags: [{ id: tag.id }] });
    const original = await service().createActivityIdempotently(
      request,
      options(key)
    );
    const before = await balance();
    await prisma.tag.delete({ where: { id: tag.id } });
    const beforeCreate = jest
      .fn()
      .mockRejectedValue(new Error('quota changed'));
    const replay = await service().createActivityIdempotently(request, {
      ...options(key),
      beforeCreate
    });
    expect(replay.id).toBe(original.id);
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(await balance()).toBe(before);
  });

  it('retains the tombstone after Order deletion and returns 410', async () => {
    const key = randomUUID();
    const s = service();
    const original = await s.createActivityIdempotently(input(), options(key));
    const before = await balance();
    await prisma.order.delete({ where: { id: original.id } });
    await expect(
      s.createActivityIdempotently(input(), options(key))
    ).rejects.toMatchObject({ status: 410 });
    expect(
      await prisma.activityCreateIdempotency.count({ where: { userId, key } })
    ).toBe(1);
    expect(await balance()).toBe(before);
  });

  it('safely retries post-commit gathering failures using the stable job ID', async () => {
    const key = randomUUID();
    gathering.addJobToQueue.mockRejectedValueOnce(
      new Error('synthetic queue failure')
    );
    await expect(
      service().createActivityIdempotently(input(), options(key))
    ).rejects.toThrow('synthetic queue failure');
    const before = await balance();
    const replay = await service().createActivityIdempotently(
      input(),
      options(key)
    );
    expect(await prisma.order.count({ where: { id: replay.id } })).toBe(1);
    expect(await balance()).toBe(before);
    expect(
      gathering.addJobToQueue.mock.calls.map(([job]) => job.opts.jobId)
    ).toEqual([`YAHOO-${symbol}`, `YAHOO-${symbol}`]);
  });
});
