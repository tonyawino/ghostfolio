import { AccountBalanceService } from '@ghostfolio/api/app/account-balance/account-balance.service';

import { Prisma } from '@prisma/client';

import { AccountService } from './account.service';

const userId = 'synthetic-user';
const accountId = 'synthetic-account';
const date = new Date('2026-01-01');

function fixture() {
  const database = {
    account: {
      findUnique: jest.fn().mockResolvedValue({
        id: accountId,
        currency: 'USD',
        balances: [{ value: 20 }]
      })
    },
    accountBalance: { upsert: jest.fn().mockResolvedValue({ value: 13 }) }
  };
  const transaction = {
    account: {
      findUnique: jest.fn().mockResolvedValue({
        id: accountId,
        currency: 'USD',
        balances: [{ value: 20 }]
      })
    },
    accountBalance: { upsert: jest.fn().mockResolvedValue({ value: 13 }) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: accountId }])
  };
  const emitter = { emit: jest.fn() };
  const balances = Object.assign(
    Object.create(AccountBalanceService.prototype),
    { prismaService: database, eventEmitter: emitter }
  ) as AccountBalanceService;
  const exchange = { toCurrencyAtDate: jest.fn().mockResolvedValue(-7) };
  const account = Object.assign(Object.create(AccountService.prototype), {
    prismaService: database,
    accountBalanceService: balances,
    exchangeRateDataService: exchange
  }) as AccountService;
  return { database, transaction, emitter, balances, account, exchange };
}

describe('account balance transaction seam for activity creates', () => {
  it('preserves the default read/write client and event for legacy callers', async () => {
    const { account, database, transaction, emitter } = fixture();
    await account.updateAccountBalance({
      accountId,
      userId,
      date,
      amount: -7,
      currency: 'USD'
    });
    expect(database.account.findUnique).toHaveBeenCalledTimes(1);
    expect(database.accountBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: 13 } })
    );
    expect(transaction.accountBalance.upsert).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('uses one transaction for the locked balance read and write without pre-commit events', async () => {
    const { account, database, transaction, emitter } = fixture();
    await account.updateAccountBalance(
      { accountId, userId, date, amount: -7, currency: 'USD' },
      transaction as unknown as Prisma.TransactionClient
    );
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.account.findUnique).toHaveBeenCalledTimes(1);
    expect(transaction.accountBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: 13 } })
    );
    expect(database.account.findUnique).not.toHaveBeenCalled();
    expect(database.accountBalance.upsert).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
  it('fails a keyed balance update if the currency conversion is unavailable', async () => {
    const { account, transaction, emitter, exchange } = fixture();
    exchange.toCurrencyAtDate.mockResolvedValue(undefined);
    await expect(
      account.updateAccountBalance(
        { accountId, userId, date, amount: -7, currency: 'USD' },
        transaction as unknown as Prisma.TransactionClient
      )
    ).rejects.toThrow('Unable to convert account balance amount');
    expect(transaction.accountBalance.upsert).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
