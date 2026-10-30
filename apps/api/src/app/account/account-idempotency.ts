import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const ACCOUNT_CREATE_OPERATION = 'account.create';

export function parseIdempotencyKey(
  value?: string | string[]
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new BadRequestException('Invalid Idempotency-Key');
  }
  return value.toLowerCase();
}

export function createAccountRequestDigest(input: {
  id?: string | null;
  name?: string | null;
  currency?: string | null;
  comment?: string | null;
  balance?: number | null;
  platformId?: string | null;
  tagIds?: string[];
}): string {
  const canonical = {
    id: input.id ?? null,
    name: input.name ?? null,
    currency: input.currency ?? null,
    comment: input.comment ?? null,
    balance: input.balance ?? null,
    platformId: input.platformId ?? null,
    tagIds: [...(input.tagIds ?? [])].sort()
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}
