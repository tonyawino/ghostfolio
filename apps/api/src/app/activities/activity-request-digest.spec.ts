import {
  createActivityRequestDigest,
  ActivityCreateInput
} from './activity-idempotency';

const digest = (data: unknown) =>
  createActivityRequestDigest(data as ActivityCreateInput);
const base = () => ({
  userId: 'owner',
  accountId: 'account',
  type: 'BUY',
  date: new Date('2026-01-01T00:00:00Z'),
  fee: 1,
  quantity: 2,
  unitPrice: 3,
  currency: 'USD',
  tags: [{ id: 'b' }, { id: 'a' }],
  SymbolProfile: {
    connectOrCreate: {
      create: { dataSource: 'YAHOO', symbol: 'SYNTH', currency: 'EUR' }
    }
  }
});

describe('activity effective request digest', () => {
  it('normalizes optional defaults, date spelling, field order and tag ordering', () => {
    expect(digest(base())).toBe(
      digest({
        ...base(),
        date: '2025-12-31T19:00:00-05:00',
        comment: '',
        updateAccountBalance: false,
        tags: [{ id: 'a' }, { id: 'b' }]
      })
    );
    expect(digest({ ...base(), tags: undefined })).toBe(
      digest({ ...base(), tags: [] })
    );
  });
  it('normalizes the effective MANUAL data source of non-investment activities', () => {
    const fee = {
      ...base(),
      type: 'FEE',
      SymbolProfile: {
        connectOrCreate: { create: { currency: 'EUR', symbol: 'Fees' } }
      }
    };
    expect(digest(fee)).toBe(
      digest({
        ...fee,
        SymbolProfile: {
          connectOrCreate: {
            create: { currency: 'EUR', symbol: 'Fees', dataSource: 'MANUAL' }
          }
        }
      })
    );
  });
  it('binds every effective field, including owner, asset creation currency and balance option', () => {
    for (const change of [
      { userId: 'another' },
      { accountId: 'another' },
      { type: 'SELL' },
      { date: new Date('2026-01-02') },
      { fee: 2 },
      { quantity: 3 },
      { unitPrice: 4 },
      { currency: 'GBP' },
      { comment: 'memo' },
      { tags: [] },
      { updateAccountBalance: true },
      { assetClass: 'EQUITY' },
      { assetSubClass: 'STOCK' },
      {
        SymbolProfile: {
          connectOrCreate: {
            create: { dataSource: 'MANUAL', symbol: 'SYNTH', currency: 'EUR' }
          }
        }
      },
      {
        SymbolProfile: {
          connectOrCreate: {
            create: { dataSource: 'YAHOO', symbol: 'OTHER', currency: 'EUR' }
          }
        }
      },
      {
        SymbolProfile: {
          connectOrCreate: {
            create: { dataSource: 'YAHOO', symbol: 'SYNTH', currency: 'GBP' }
          }
        }
      }
    ]) {
      expect(digest({ ...base(), ...change })).not.toBe(digest(base()));
    }
  });
});
