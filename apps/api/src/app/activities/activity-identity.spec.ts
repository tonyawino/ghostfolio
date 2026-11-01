// sort-imports-ignore
import 'reflect-metadata';

import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { RequestWithUser } from '@ghostfolio/common/types';

import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA
} from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { DataSource, Type as ActivityType } from '@prisma/client';

import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

interface Identity {
  id: string;
  accountId: string;
  type: 'BUY' | 'SELL';
  dataSource: 'MANUAL';
  symbol: string;
  assetProfileId: string;
  assetProfileUserId: string | null;
}
interface SourceRow {
  id: string;
  userId: string;
  accountId: string | null;
  accountUserId: string | null;
  type: ActivityType;
  quantity: number;
  unitPrice: number;
  comment: string;
  SymbolProfile: {
    id: string;
    dataSource: DataSource;
    symbol: string;
    userId: string | null;
  };
}

describe('Activity batch identity service', () => {
  const userId = 'authenticated-user';
  function row(
    id = 'activity-a',
    type: ActivityType = ActivityType.BUY
  ): SourceRow {
    return {
      id,
      userId,
      accountId: 'account-id',
      accountUserId: userId,
      type,
      quantity: 999,
      unitPrice: 123,
      comment: 'must not escape',
      SymbolProfile: {
        id: `profile-${id}`,
        dataSource: DataSource.MANUAL,
        symbol: `symbol-${id}`,
        userId
      }
    };
  }
  function identity(value: SourceRow): Identity {
    return {
      id: value.id,
      accountId: value.accountId,
      type: value.type as 'BUY' | 'SELL',
      dataSource: 'MANUAL',
      symbol: value.SymbolProfile.symbol,
      assetProfileId: value.SymbolProfile.id,
      assetProfileUserId: value.SymbolProfile.userId
    };
  }
  function fixture(rows: SourceRow[], activityIds = ['activity-a']) {
    const $queryRaw = jest.fn().mockResolvedValue(rows);
    const service = new ActivitiesService(
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { $queryRaw } as unknown as PrismaService,
      null,
      null
    );
    return {
      $queryRaw,
      invoke: () => service.getActivityIdentities({ activityIds, userId })
    };
  }

  it('uses one minimal query and returns owned MANUAL BUY/SELL identities in request order', async () => {
    const first = row('activity-a');
    const second = row('activity-b', ActivityType.SELL);
    const activityIds = ['activity-b', 'activity-a'];
    const { $queryRaw, invoke } = fixture([first, second], activityIds);

    await expect(invoke()).resolves.toEqual([
      identity(second),
      identity(first)
    ]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [query, ...parameters] = $queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = query.join('?');
    expect(sql).toContain('INNER JOIN "Account"');
    expect(sql).toContain('INNER JOIN "SymbolProfile"');
    expect(sql).toContain('account_row."userId" = order_row."accountUserId"');
    expect(sql).toContain('order_row."userId" = ?');
    expect(sql).toContain('order_row."accountUserId" = ?');
    expect(sql).toContain(`profile_row."dataSource" = 'MANUAL'`);
    expect(sql).toContain(
      'profile_row."userId" IS NULL OR profile_row."userId" = ?'
    );
    expect(sql).not.toMatch(/quantity|unitPrice|comment|fee|balance/i);
    expect(parameters).toEqual([expect.anything(), userId, userId, userId]);
  });

  it('returns a null owner for a shared MANUAL profile', async () => {
    const value = row();
    value.SymbolProfile.userId = null;
    await expect(fixture([value]).invoke()).resolves.toEqual([identity(value)]);
  });

  it('supports the 100-ID bound with one query', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row(`activity-${index}`)
    );
    const { $queryRaw, invoke } = fixture(
      rows,
      rows.map(({ id }) => id).reverse()
    );
    await expect(invoke()).resolves.toHaveLength(100);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('hides a missing ID instead of returning a partial batch', async () => {
    await expect(
      fixture([row()], ['activity-a', 'missing-id']).invoke()
    ).resolves.toBeNull();
  });

  it.each([
    'owner',
    'source',
    'profile_owner',
    'type',
    'account',
    'account_owner'
  ])(
    'rejects the entire batch for unsupported %s lineage',
    async (unsupported) => {
      const value = row('activity-b');
      if (unsupported === 'owner') value.userId = 'other-user';
      if (unsupported === 'source')
        value.SymbolProfile.dataSource = DataSource.YAHOO;
      if (unsupported === 'profile_owner')
        value.SymbolProfile.userId = 'other-user';
      if (unsupported === 'type') value.type = ActivityType.FEE;
      if (unsupported === 'account') value.accountId = null;
      if (unsupported === 'account_owner') value.accountUserId = 'other-user';
      await expect(
        fixture([row(), value], ['activity-a', 'activity-b']).invoke()
      ).resolves.toBeNull();
    }
  );

  it('rejects duplicate IDs before querying', async () => {
    const { $queryRaw, invoke } = fixture(
      [row()],
      ['activity-a', 'activity-a']
    );
    await expect(invoke()).resolves.toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe('Activity batch identity controller', () => {
  const userId = 'authenticated-user';
  function fixture(
    identities: Identity[] | null,
    body: unknown = { activityIds: ['activity-a'] }
  ) {
    const getActivityIdentities = jest.fn().mockResolvedValue(identities);
    const controller = new ActivitiesController(
      { getActivityIdentities } as unknown as ActivitiesService,
      null,
      null,
      null,
      null
    );
    return {
      handler: controller.getActivityIdentities,
      getActivityIdentities,
      invoke: () =>
        controller.getActivityIdentities(
          {
            user: { id: userId },
            impersonation: { userId: 'ignored-user' }
          } as unknown as RequestWithUser,
          body as { activityIds?: unknown }
        )
    };
  }

  it('returns only the exact identity tuples and uses the authenticated principal', async () => {
    const value = {
      id: 'activity-a',
      accountId: 'account-id',
      type: 'BUY' as const,
      dataSource: 'MANUAL' as const,
      symbol: 'profile-symbol',
      assetProfileId: 'profile-id',
      assetProfileUserId: userId,
      quantity: 999,
      unitPrice: 123,
      comment: 'must not escape'
    };
    const { invoke, getActivityIdentities } = fixture([value]);
    await expect(invoke()).resolves.toEqual({
      activities: [
        {
          id: 'activity-a',
          accountId: 'account-id',
          type: 'BUY',
          dataSource: 'MANUAL',
          symbol: 'profile-symbol',
          assetProfileId: 'profile-id',
          assetProfileUserId: userId
        }
      ]
    });
    expect(getActivityIdentities).toHaveBeenCalledWith({
      activityIds: ['activity-a'],
      userId
    });
  });

  it('returns the same 404 for duplicate, foreign, missing and unsupported batches', async () => {
    await expect(fixture(null).invoke()).rejects.toMatchObject({
      status: 404,
      response: 'Not Found'
    });
  });

  it.each([
    null,
    {},
    { activityIds: [] },
    { activityIds: 'activity-a' },
    { activityIds: [null] },
    { activityIds: [''] },
    { activityIds: Array(101).fill('a') }
  ])(
    'rejects invalid or oversized request shape before lookup: %j',
    async (body) => {
      const { invoke, getActivityIdentities } = fixture([], body);
      await expect(invoke()).rejects.toMatchObject({ status: 400 });
      expect(getActivityIdentities).not.toHaveBeenCalled();
    }
  );

  it('requires JWT authentication and returns HTTP 200 for POST /activities/identities', () => {
    const { handler } = fixture(null);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('identities');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      AuthGuard('jwt')
    );
  });
});
