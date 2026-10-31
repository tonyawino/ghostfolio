import { NON_INVESTMENT_ACTIVITY_TYPES } from '@ghostfolio/common/config';

import { AssetClass, AssetSubClass, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

export const ACTIVITY_CREATE_OPERATION = 'activity.create';
export const ACTIVITY_CREATE_IDEMPOTENCY_CAPABILITY =
  'activity-create-idempotency-v1';

export type ActivityCreateInput = Prisma.OrderCreateInput & {
  accountId?: string;
  assetClass?: AssetClass;
  assetSubClass?: AssetSubClass;
  symbol?: string;
  tags?: { id: string }[];
  updateAccountBalance?: boolean;
  userId: string;
};

/** Hash the effective validated request before generated profile IDs or draft tags. */
export function createActivityRequestDigest(data: ActivityCreateInput): string {
  const profile = data.SymbolProfile.connectOrCreate.create;
  const canonical = {
    userId: data.userId,
    accountId: data.accountId || null,
    assetClass: data.assetClass ?? null,
    assetSubClass: data.assetSubClass ?? null,
    comment: data.comment || null,
    currency: data.currency ?? null,
    date: new Date(data.date).toISOString(),
    fee: data.fee,
    quantity: data.quantity,
    unitPrice: data.unitPrice,
    type: data.type,
    tags: (data.tags ?? []).map(({ id }) => id).sort(),
    updateAccountBalance: data.updateAccountBalance ?? false,
    profile: {
      currency: profile.currency ?? null,
      dataSource: NON_INVESTMENT_ACTIVITY_TYPES.includes(data.type)
        ? 'MANUAL'
        : (profile.dataSource ?? null),
      symbol: profile.symbol,
      name: profile.name ?? null
    }
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}
