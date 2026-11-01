import { AccountService } from '@ghostfolio/api/app/account/account.service';
import {
  activityDummyData,
  assetProfileDummyData
} from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator-test-utils';
import { WHERE_ACTIVITY_NOT_DRAFT } from '@ghostfolio/api/helper/activity.helper';
import { AssetProfileSplitService } from '@ghostfolio/api/services/asset-profile-split/asset-profile-split.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { DataGatheringService } from '@ghostfolio/api/services/queues/data-gathering/data-gathering.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';
import { getIntervalFromDateRange } from '@ghostfolio/common/calculation-helper';
import {
  INVESTMENT_ACTIVITY_TYPES,
  NON_INVESTMENT_ACTIVITY_TYPES
} from '@ghostfolio/common/config';
import { parseDate } from '@ghostfolio/common/helper';
import { Activity, Filter } from '@ghostfolio/common/interfaces';
import { DateRange } from '@ghostfolio/common/types';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AssetClass,
  AssetProfileSplit,
  AssetSubClass,
  DataSource,
  Prisma,
  Type as ActivityType
} from '@prisma/client';
import { Big } from 'big.js';
import { isUUID } from 'class-validator';
import { endOfDay } from 'date-fns';

import { ActivitiesService } from './activities.service';

describe('ActivitiesService', () => {
  let activitiesService: ActivitiesService;
  let getSplitsByUserId: jest.Mock;
  let accountService: { getCashDetails: jest.Mock };

  beforeEach(() => {
    getSplitsByUserId = jest.fn().mockResolvedValue([]);
    accountService = { getCashDetails: jest.fn() };

    activitiesService = new ActivitiesService(
      null,
      accountService as unknown as AccountService,
      { getSplitsByUserId } as unknown as AssetProfileSplitService,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );
  });

  describe('createActivity', () => {
    it('creates a custom asset profile with a UUID if no asset profile exists for a symbol with the prefix', async () => {
      const assetProfile = await getCreatedAssetProfile({ symbol: 'GF_COPX' });

      expect(isUUID(assetProfile.symbol)).toBe(true);
      expect(assetProfile.name).toBe('GF_COPX');
    });

    it('connects to the existing asset profile of a symbol with the prefix', async () => {
      const assetProfile = await getCreatedAssetProfile({
        existingAssetProfile: { id: 'asset-profile-id' },
        symbol: 'GF_COPX'
      });

      expect(assetProfile.symbol).toBe('GF_COPX');
    });

    it('creates a custom asset profile with the requested UUID if no asset profile exists', async () => {
      const symbol = '1ad7d4a2-6b2d-4e0f-9b1f-2c0f8d3e5a7b';

      const assetProfile = await getCreatedAssetProfile({ symbol });

      expect(assetProfile.symbol).toBe(symbol);
    });

    async function getCreatedAssetProfile({
      existingAssetProfile,
      symbol
    }: {
      existingAssetProfile?: { id: string };
      symbol: string;
    }) {
      const create = jest.fn(({ data }: Prisma.OrderCreateArgs) => {
        return {
          ...data,
          SymbolProfile: data.SymbolProfile.connectOrCreate.create
        };
      });

      const service = new ActivitiesService(
        null,
        null,
        null,
        null,
        null,
        null,
        { emit: jest.fn() } as unknown as EventEmitter2,
        null,
        null,
        {
          order: { create },
          symbolProfile: {
            findUnique: jest
              .fn()
              .mockResolvedValue(existingAssetProfile ?? null)
          }
        } as unknown as PrismaService,
        null,
        { validateTagIds: jest.fn() } as unknown as TagService
      );

      await service.createActivity({
        currency: 'USD',
        date: parseDate('2024-01-01'),
        fee: 0,
        quantity: 1,
        SymbolProfile: {
          connectOrCreate: {
            create: { symbol, currency: 'USD', dataSource: DataSource.MANUAL },
            where: {
              dataSource_symbol: { symbol, dataSource: DataSource.MANUAL }
            }
          }
        },
        type: 'BUY',
        unitPrice: 100,
        user: { connect: { id: 'user-id' } },
        userId: 'user-id'
      });

      const { create: assetProfile, where } =
        create.mock.calls[0][0].data.SymbolProfile.connectOrCreate;

      expect(where.dataSource_symbol).toEqual({
        dataSource: DataSource.MANUAL,
        symbol: assetProfile.symbol
      });

      return assetProfile;
    }
  });

  describe('getActivities', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the activities with the asset profile but without the relation to the symbol profile', async () => {
      const assetProfile = {
        ...assetProfileDummyData,
        currency: 'USD',
        dataSource: DataSource.YAHOO,
        name: 'Apple Inc.',
        symbol: 'AAPL'
      };

      const findMany = jest.fn().mockResolvedValue([
        {
          ...activityDummyData,
          account: null,
          currency: 'USD',
          date: parseDate('2021-01-01'),
          fee: 1,
          id: 'activity-id',
          quantity: 10,
          SymbolProfile: {
            currency: 'USD',
            dataSource: DataSource.YAHOO,
            symbol: 'AAPL'
          },
          tags: [],
          type: 'BUY',
          unitPrice: 100
        }
      ]);

      const service = new ActivitiesService(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        {
          toCurrencyAtDate: jest.fn().mockResolvedValue(0)
        } as unknown as ExchangeRateDataService,
        null,
        {
          order: {
            findMany,
            count: jest.fn().mockResolvedValue(1)
          }
        } as unknown as PrismaService,
        {
          getSymbolProfiles: jest
            .fn()
            .mockResolvedValue([
              { ...assetProfile, dataSource: DataSource.MANUAL },
              assetProfile
            ])
        } as unknown as SymbolProfileService,
        null
      );

      const { activities } = await service.getActivities({
        userCurrency: 'USD',
        userId: 'user-id'
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            SymbolProfile: {
              select: { currency: true, dataSource: true, symbol: true }
            }
          })
        })
      );
      expect(activities).toHaveLength(1);
      expect(activities[0]).not.toHaveProperty('SymbolProfile');
      expect(activities[0].assetProfile).toBe(assetProfile);
    });

    it('excludes the activities of the start date of a date range', async () => {
      jest.useFakeTimers().setSystemTime(parseDate('2024-06-15').getTime());

      expect(await getDateConditions('ytd')).toEqual(
        expect.arrayContaining([
          { date: { gt: endOfDay(parseDate('2023-12-31')) } },
          { date: { lte: endOfDay(parseDate('2024-06-15')) } }
        ])
      );
    });

    it('keeps the start date of the date range max', async () => {
      expect(await getDateConditions('max')).toEqual(
        expect.arrayContaining([{ date: { gt: new Date(0) } }])
      );
    });

    async function getDateConditions(dateRange: DateRange) {
      const findMany = jest.fn().mockResolvedValue([]);

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
        {
          order: {
            findMany,
            count: jest.fn().mockResolvedValue(0)
          }
        } as unknown as PrismaService,
        {
          getSymbolProfiles: jest.fn().mockResolvedValue([])
        } as unknown as SymbolProfileService,
        null
      );

      const { endDate, startDate } = getIntervalFromDateRange({ dateRange });

      await service.getActivities({
        endDate,
        startDate,
        userCurrency: 'USD',
        userId: 'user-id'
      });

      return findMany.mock.calls[0][0].where.AND;
    }
  });

  describe('getActivitiesForPortfolioCalculator', () => {
    it('leaves an activity unchanged when no splits exist', async () => {
      const activity = createActivity({ symbol: 'AAPL' });

      const result = await getAdjustedActivity(activity, []);

      expect(result).toEqual(activity);
      expect(result).toBe(activity);
    });

    it.each([
      { denominator: 1, expectedPrice: 50, expectedQuantity: 20, numerator: 2 },
      {
        denominator: 10,
        expectedPrice: 1000,
        expectedQuantity: 1,
        numerator: 1
      }
    ])(
      'applies a $numerator:$denominator split to quantity and price',
      async ({ denominator, expectedPrice, expectedQuantity, numerator }) => {
        const result = await getAdjustedActivity(
          createActivity({ symbol: 'AAPL' }),
          [createSplit('2021-01-01', numerator, denominator)]
        );

        expect(result.quantity).toBe(expectedQuantity);
        expect(result.unitPrice).toBe(expectedPrice);
        expect(result.unitPriceInAssetProfileCurrency).toBe(expectedPrice);
      }
    );

    it('adjusts only activities before the split calendar date', async () => {
      const split = createSplit('2021-01-01', 2, 1);
      const activityBeforeSplit = createActivity({
        date: '2020-12-31T23:00:00.000Z',
        symbol: 'AAPL'
      });
      const activityOnSplitDate = createActivity({
        date: '2021-01-01T23:00:00.000Z',
        symbol: 'AAPL'
      });
      const activityAfterSplit = createActivity({
        date: '2021-01-02T00:00:00.000Z',
        symbol: 'AAPL'
      });

      expect(
        (await getAdjustedActivity(activityBeforeSplit, [split])).quantity
      ).toBe(20);
      expect(
        (await getAdjustedActivity(activityOnSplitDate, [split])).quantity
      ).toBe(10);
      expect(
        (await getAdjustedActivity(activityAfterSplit, [split])).quantity
      ).toBe(10);
    });

    it('applies multiple splits cumulatively with exact ratio arithmetic', async () => {
      const result = await getAdjustedActivity(
        createActivity({ symbol: 'AAPL' }),
        [createSplit('2021-01-01', 2, 1), createSplit('2022-01-01', 1, 3)]
      );

      expect(new Big(result.quantity).toFixed(15)).toBe(
        new Big(20).div(3).toFixed(15)
      );
      expect(result.unitPrice).toBe(150);
    });

    it('preserves fees and total activity value', async () => {
      const activity = createActivity({ symbol: 'AAPL' });
      activity.feeInAssetProfileCurrency = 12;
      activity.feeInBaseCurrency = 15;

      const result = await getAdjustedActivity(activity, [
        createSplit('2021-01-01', 2, 1)
      ]);

      expect(result).toMatchObject({
        feeInAssetProfileCurrency: 12,
        feeInBaseCurrency: 15,
        value: 1000,
        valueInBaseCurrency: 1000
      });
      expect(result.quantity * result.unitPrice).toBe(1000);
    });

    it('does not apply splits from another symbol or data source', async () => {
      const activity = createActivity({ symbol: 'AAPL' });
      const split = createSplit('2021-01-01', 2, 1);

      jest.spyOn(activitiesService, 'getActivities').mockResolvedValue({
        activities: [activity],
        count: 1
      });
      getSplitsByUserId.mockResolvedValue([
        { ...split, symbolProfileId: 'YAHOO-MSFT-profile' },
        { ...split, symbolProfileId: 'MANUAL-AAPL-profile' }
      ]);

      const result =
        await activitiesService.getActivitiesForPortfolioCalculator({
          userCurrency: 'USD',
          userId: 'user-id'
        });

      expect(result.activities[0].quantity).toBe(10);
      expect(result.activities[0].unitPrice).toBe(100);
    });

    it.each(INVESTMENT_ACTIVITY_TYPES)(
      'adjusts %s activities',
      async (type) => {
        const activity = createActivity({ symbol: 'AAPL' });
        activity.type = type as Activity['type'];

        const result = await getAdjustedActivity(activity, [
          createSplit('2021-01-01', 2, 1)
        ]);

        expect(result.quantity).toBe(20);
        expect(result.unitPrice).toBe(50);
        expect(result.quantity * result.unitPrice).toBe(1000);
      }
    );

    it.each(NON_INVESTMENT_ACTIVITY_TYPES)(
      'leaves %s activities unchanged',
      async (type) => {
        const activity = createActivity({ symbol: 'AAPL' });
        activity.type = type as Activity['type'];

        const result = await getAdjustedActivity(activity, [
          createSplit('2021-01-01', 2, 1)
        ]);

        expect(result).toBe(activity);
        expect(result.quantity).toBe(10);
        expect(result.unitPrice).toBe(100);
      }
    );

    it('loads and applies splits to standard activities while preserving filters', async () => {
      const activity = createActivity({ symbol: 'AAPL' });
      const filters = [{ id: 'AAPL', type: 'SYMBOL' }] as Filter[];
      const split = createSplit();

      jest.spyOn(activitiesService, 'getActivities').mockResolvedValue({
        activities: [activity],
        count: 1
      });
      getSplitsByUserId.mockResolvedValue([split]);

      const result =
        await activitiesService.getActivitiesForPortfolioCalculator({
          filters,
          userCurrency: 'USD',
          userId: 'user-id'
        });

      expect(activitiesService.getActivities).toHaveBeenCalledWith({
        filters,
        userCurrency: 'USD',
        userId: 'user-id',
        withExcludedAccountsAndActivities: false
      });
      expect(getSplitsByUserId).toHaveBeenCalledWith({ userId: 'user-id' });
      expect(result.activities[0]).toMatchObject({
        quantity: 20,
        unitPrice: 50,
        unitPriceInAssetProfileCurrency: 50
      });
    });

    it('includes excluded accounts and activities when requested', async () => {
      jest.spyOn(activitiesService, 'getActivities').mockResolvedValue({
        activities: [],
        count: 0
      });

      await activitiesService.getActivitiesForPortfolioCalculator({
        userCurrency: 'USD',
        userId: 'user-id',
        withExcludedAccountsAndActivities: true
      });

      expect(activitiesService.getActivities).toHaveBeenCalledWith({
        filters: undefined,
        userCurrency: 'USD',
        userId: 'user-id',
        withExcludedAccountsAndActivities: true
      });
    });

    it('does not adjust synthetic cash activities', async () => {
      const activity = createActivity({ symbol: 'AAPL' });
      const cashActivity = createActivity({
        assetSubClass: 'CASH',
        currency: 'USD',
        dataSource: DataSource.YAHOO,
        quantity: 100,
        symbol: 'USD',
        unitPrice: 1
      });
      const split = createSplit();

      jest.spyOn(activitiesService, 'getActivities').mockResolvedValue({
        activities: [activity],
        count: 1
      });
      jest.spyOn(activitiesService, 'getCashActivities').mockResolvedValue({
        activities: [cashActivity],
        count: 1
      });
      accountService.getCashDetails.mockResolvedValue({ accounts: [] });
      getSplitsByUserId.mockResolvedValue([split]);

      const result =
        await activitiesService.getActivitiesForPortfolioCalculator({
          userCurrency: 'USD',
          userId: 'user-id',
          withCash: true
        });

      expect(getSplitsByUserId).toHaveBeenCalledWith({ userId: 'user-id' });
      expect(result.activities).toEqual([
        expect.objectContaining({
          assetProfile: expect.objectContaining({ symbol: 'AAPL' }),
          quantity: 20
        }),
        cashActivity
      ]);
    });

    async function getAdjustedActivity(
      activity: Activity,
      splits: AssetProfileSplit[]
    ) {
      jest.spyOn(activitiesService, 'getActivities').mockResolvedValue({
        activities: [activity],
        count: 1
      });
      getSplitsByUserId.mockResolvedValue(
        splits.map((split) => {
          return { ...split, symbolProfileId: activity.assetProfile.id };
        })
      );

      const result =
        await activitiesService.getActivitiesForPortfolioCalculator({
          userCurrency: 'USD',
          userId: 'user-id'
        });

      return result.activities[0];
    }
  });

  describe('getLatestActivity', () => {
    it('filters by type and unit price and excludes draft activities', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);

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
        { order: { findFirst } } as unknown as PrismaService,
        null,
        null
      );

      await service.getLatestActivity({
        dataSource: DataSource.YAHOO,
        symbol: 'AAPL',
        types: [ActivityType.BUY, ActivityType.SELL]
      });

      expect(findFirst).toHaveBeenCalledWith({
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        where: {
          ...WHERE_ACTIVITY_NOT_DRAFT,
          SymbolProfile: { dataSource: DataSource.YAHOO, symbol: 'AAPL' },
          type: { in: [ActivityType.BUY, ActivityType.SELL] },
          unitPrice: { gt: 0 }
        }
      });
    });
  });

  describe('updateActivity', () => {
    const expectedBuyProfileId = '7b9c2fb8-b593-4d3e-b5f7-8263b6cb77ee';

    it('requires an expected source profile UUID for an explicit BUY name', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
      await expect(
        getUpdatedActivityData({
          assetProfileName: 'RENAMED',
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects an expected source profile without an explicit BUY name', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
      await expect(
        getUpdatedActivityData({
          expectedAssetProfileId: expectedBuyProfileId,
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects a BUY source profile that differs from its expected UUID', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
      await expect(
        getUpdatedActivityData({
          assetProfileName: 'RENAMED',
          expectedAssetProfileId: expectedBuyProfileId,
          sourceProfileId: 'changed-profile-id',
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      'activity_profile',
      'activity_owner',
      'activity_type',
      'profile_owner',
      'profile_source'
    ])(
      'rechecks BUY %s under the activity/profile transaction locks',
      async (changed) => {
        const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
        const transaction = jest.fn(
          async (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>
          ) =>
            callback({
              $queryRaw: jest
                .fn()
                .mockResolvedValueOnce([
                  {
                    id: 'activity-id',
                    userId:
                      changed === 'activity_owner' ? 'other-user' : 'user-id',
                    type:
                      changed === 'activity_type'
                        ? ActivityType.SELL
                        : ActivityType.BUY,
                    symbolProfileId:
                      changed === 'activity_profile'
                        ? 'changed-profile-id'
                        : expectedBuyProfileId
                  }
                ])
                .mockResolvedValueOnce([
                  {
                    id: expectedBuyProfileId,
                    dataSource:
                      changed === 'profile_source'
                        ? DataSource.YAHOO
                        : DataSource.MANUAL,
                    userId:
                      changed === 'profile_owner' ? 'other-user' : 'user-id'
                  }
                ]),
              order: { update }
            } as unknown as Prisma.TransactionClient)
        );
        await expect(
          getUpdatedActivityData({
            assetProfileName: 'RENAMED',
            expectedAssetProfileId: expectedBuyProfileId,
            transaction,
            update,
            userId: 'user-id'
          })
        ).rejects.toThrow(
          changed === 'profile_owner' ? ForbiddenException : BadRequestException
        );
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
      }
    );

    it('locks BUY then its exact expected MANUAL profile and renames atomically', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
      const lockQueries: string[] = [];
      const queryRaw = jest.fn((strings: TemplateStringsArray) => {
        lockQueries.push(strings.join(' '));
        return Promise.resolve(
          lockQueries.length === 1
            ? [
                {
                  id: 'activity-id',
                  userId: 'user-id',
                  type: ActivityType.BUY,
                  symbolProfileId: expectedBuyProfileId
                }
              ]
            : [
                {
                  id: expectedBuyProfileId,
                  dataSource: DataSource.MANUAL,
                  userId: 'user-id'
                }
              ]
        );
      });
      const transaction = jest.fn(
        async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          callback({
            $queryRaw:
              queryRaw as unknown as Prisma.TransactionClient['$queryRaw'],
            order: { update }
          } as unknown as Prisma.TransactionClient)
      );
      await getUpdatedActivityData({
        assetProfileName: 'RENAMED',
        expectedAssetProfileId: expectedBuyProfileId,
        transaction,
        update,
        userId: 'user-id'
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries.every((query) => query.includes('FOR UPDATE'))).toBe(
        true
      );
      expect(lockQueries[0]).toContain('FROM "Order"');
      expect(lockQueries[1]).toContain('FROM "SymbolProfile"');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'activity-id',
            userId: 'user-id',
            type: ActivityType.BUY,
            symbolProfileId: expectedBuyProfileId
          },
          data: expect.objectContaining({
            SymbolProfile: {
              update: {
                data: expect.objectContaining({ name: 'RENAMED' }),
                where: {
                  id: expectedBuyProfileId,
                  userId: 'user-id',
                  dataSource: DataSource.MANUAL
                }
              }
            }
          })
        })
      );
    });

    it('locks and revalidates the SELL and destination profile in the update transaction', async () => {
      const assetProfileId = 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a';
      const lockQueries: string[] = [];
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });
      const queryRaw = jest.fn((strings: TemplateStringsArray) => {
        lockQueries.push(strings.join(' '));
        return Promise.resolve(
          lockQueries.length === 1
            ? [
                {
                  id: 'activity-id',
                  userId: 'user-id',
                  type: ActivityType.SELL,
                  symbolProfileId: 'profile-id'
                }
              ]
            : [
                {
                  id: 'profile-id',
                  dataSource: DataSource.MANUAL,
                  symbol: 'OLDCO',
                  userId: 'user-id'
                },
                {
                  id: assetProfileId,
                  dataSource: DataSource.MANUAL,
                  symbol: 'NEWCO',
                  userId: null
                }
              ]
        );
      });
      const transaction = jest.fn(
        async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          callback({
            $queryRaw:
              queryRaw as unknown as Prisma.TransactionClient['$queryRaw'],
            order: { update }
          } as unknown as Prisma.TransactionClient)
      );

      await getUpdatedActivityData({
        activityType: ActivityType.SELL,
        assetProfileId,
        symbol: 'NEWCO',
        transaction,
        type: ActivityType.SELL,
        update,
        userId: 'user-id'
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries.every((query) => query.includes('FOR UPDATE'))).toBe(
        true
      );
      expect(lockQueries[1]).toContain('ORDER BY "id"');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'activity-id',
            userId: 'user-id',
            type: ActivityType.SELL,
            symbolProfileId: 'profile-id'
          })
        })
      );
    });

    it('connects a SELL activity to the exact existing shared MANUAL profile', async () => {
      const data = await getUpdatedActivityData({
        activityType: ActivityType.SELL,
        assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
        profileOwner: null,
        symbol: 'NEWCO',
        type: ActivityType.SELL,
        userId: 'user-id'
      });

      expect(data.SymbolProfile).toEqual({
        connect: { id: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a' }
      });
    });

    it('connects a SELL activity to an exact same-user MANUAL profile', async () => {
      const data = await getUpdatedActivityData({
        activityType: ActivityType.SELL,
        assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
        profileOwner: 'user-id',
        symbol: 'NEWCO',
        type: ActivityType.SELL,
        userId: 'user-id'
      });

      expect(data.SymbolProfile).toEqual({
        connect: { id: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a' }
      });
    });

    it('rejects a missing SELL target profile before updating the activity', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });

      await expect(
        getUpdatedActivityData({
          activityType: ActivityType.SELL,
          assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
          profileExists: false,
          symbol: 'NEWCO',
          type: ActivityType.SELL,
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects a SELL target profile owned by another user before updating the activity', async () => {
      const update = jest.fn().mockResolvedValue({ userId: 'user-id' });

      await expect(
        getUpdatedActivityData({
          activityType: ActivityType.SELL,
          assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
          profileOwner: 'foreign-user-id',
          symbol: 'NEWCO',
          type: ActivityType.SELL,
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it.each([ActivityType.BUY])(
      'updates an explicitly named manual %s profile without changing its key',
      async (type) => {
        const data = await getUpdatedActivityData({
          activityType: type,
          assetProfileName: 'RENAMED',
          expectedAssetProfileId: expectedBuyProfileId,
          type,
          userId: 'user-id'
        });

        expect(data.SymbolProfile).toEqual({
          update: {
            data: { name: 'RENAMED' },
            where: {
              id: expectedBuyProfileId,
              userId: 'user-id',
              dataSource: DataSource.MANUAL
            }
          }
        });
        expect(data).not.toHaveProperty('assetProfileName');
      }
    );

    it('preserves the label when ordinary callers send the existing profile UUID', async () => {
      const data = await getUpdatedActivityData({
        symbol: 'a7f68467-4f77-42da-82d2-2c701456cc93',
        userId: 'user-id'
      });

      expect(data.SymbolProfile.update).not.toHaveProperty('data.name');
      expect(data.comment).toBeNull();
    });

    it.each([
      {
        profileOwner: null,
        profileDataSource: DataSource.MANUAL,
        error: ForbiddenException
      },
      {
        profileOwner: 'other-user-id',
        profileDataSource: DataSource.MANUAL,
        error: ForbiddenException
      },
      {
        profileOwner: 'user-id',
        profileDataSource: DataSource.YAHOO,
        error: BadRequestException
      }
    ])(
      'rejects explicit names for an unowned or shared profile: %j',
      async ({ profileOwner, profileDataSource, error }) => {
        const update = jest.fn();

        await expect(
          getUpdatedActivityData({
            assetProfileName: 'RENAMED',
            expectedAssetProfileId: expectedBuyProfileId,
            profileDataSource,
            update,
            userId: profileOwner
          })
        ).rejects.toThrow(error);
        expect(update).not.toHaveBeenCalled();
      }
    );

    it.each([
      { dataSource: DataSource.YAHOO, type: ActivityType.BUY },
      { dataSource: DataSource.MANUAL, type: ActivityType.SELL },
      { dataSource: DataSource.MANUAL, type: ActivityType.FEE }
    ])(
      'rejects explicit names for unsupported source/type: %j',
      async ({ dataSource, type }) => {
        const update = jest.fn();

        await expect(
          getUpdatedActivityData({
            assetProfileName: 'RENAMED',
            expectedAssetProfileId: expectedBuyProfileId,
            dataSource,
            activityType: type,
            type,
            update,
            userId: 'user-id'
          })
        ).rejects.toThrow(BadRequestException);
        expect(update).not.toHaveBeenCalled();
      }
    );

    it('rejects an explicit name when the persisted activity type does not match', async () => {
      const update = jest.fn();

      await expect(
        getUpdatedActivityData({
          activityType: ActivityType.SELL,
          assetProfileName: 'RENAMED',
          expectedAssetProfileId: expectedBuyProfileId,
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('preserves an omitted comment only when explicitly requested', async () => {
      const data = await getUpdatedActivityData({
        preserveComment: true,
        userId: 'user-id'
      });

      expect(data).not.toHaveProperty('comment');
      expect(data).not.toHaveProperty('preserveComment');
    });

    it('keeps an explicit comment clear when preservation is requested', async () => {
      const data = await getUpdatedActivityData({
        comment: '',
        preserveComment: true,
        userId: 'user-id'
      });

      expect(data.comment).toBeNull();
    });

    it('rejects comment preservation for another user activity', async () => {
      const update = jest.fn();

      await expect(
        getUpdatedActivityData({
          activityOwner: 'other-user-id',
          preserveComment: true,
          update,
          userId: 'user-id'
        })
      ).rejects.toThrow(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it('does not allow an update payload to change the activity ID', async () => {
      const data = await getUpdatedActivityData({
        activityId: 'replacement-id',
        userId: 'user-id'
      });

      expect(data).not.toHaveProperty('id');
    });

    it('updates the custom asset profile of the user', async () => {
      const data = await getUpdatedActivityData({ userId: 'user-id' });

      expect(data.SymbolProfile).toEqual({
        update: {
          data: {
            assetClass: AssetClass.COMMODITY,
            assetSubClass: AssetSubClass.PRECIOUS_METAL
          },
          where: { userId: 'user-id' }
        }
      });
    });

    it.each([
      { owner: 'the admin', userId: null },
      { owner: 'another user', userId: 'other-user-id' }
    ])('does not update the asset profile of $owner', async ({ userId }) => {
      const data = await getUpdatedActivityData({ userId });

      expect(data).not.toHaveProperty('SymbolProfile');
    });

    it('does not update the asset profile of a data provider', async () => {
      const data = await getUpdatedActivityData({
        dataSource: DataSource.YAHOO,
        symbol: 'AAPL',
        type: ActivityType.FEE,
        userId: null
      });

      expect(data).not.toHaveProperty('SymbolProfile');
    });

    async function getUpdatedActivityData({
      activityOwner = 'user-id',
      activityType = ActivityType.BUY,
      assetProfileId,
      assetProfileName,
      comment,
      activityId,
      dataSource = DataSource.MANUAL,
      expectedAssetProfileId,
      preserveComment,
      profileDataSource = DataSource.MANUAL,
      profileOwner = 'user-id',
      profileExists = true,
      symbol = 'GF_GOLD',
      sourceProfileId = expectedAssetProfileId ?? 'profile-id',
      type = ActivityType.BUY,
      transaction,
      update = jest.fn().mockResolvedValue({ userId: 'user-id' }),
      userId
    }: {
      activityOwner?: string;
      activityType?: ActivityType;
      assetProfileId?: string;
      assetProfileName?: string;
      comment?: string;
      activityId?: string;
      dataSource?: DataSource;
      expectedAssetProfileId?: string;
      preserveComment?: boolean;
      profileDataSource?: DataSource;
      profileExists?: boolean;
      profileOwner?: string | null;
      symbol?: string;
      sourceProfileId?: string;
      type?: ActivityType;
      transaction?: jest.Mock;
      update?: jest.Mock;
      userId: string | null;
    }) {
      const prismaTransaction =
        transaction ??
        jest.fn(
          async (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>
          ) =>
            callback({
              $queryRaw: jest
                .fn()
                .mockResolvedValueOnce([
                  {
                    id: 'activity-id',
                    userId: 'user-id',
                    type: activityType,
                    symbolProfileId: sourceProfileId
                  }
                ])
                .mockResolvedValueOnce([
                  {
                    id: sourceProfileId,
                    dataSource: profileDataSource,
                    symbol: 'OLD_SYMBOL',
                    userId
                  },
                  ...(assetProfileId
                    ? [
                        {
                          id: assetProfileId,
                          dataSource,
                          symbol,
                          userId: profileOwner
                        }
                      ]
                    : [])
                ]),
              order: { update }
            } as unknown as Prisma.TransactionClient)
        );
      const service = new ActivitiesService(
        null,
        null,
        null,
        null,
        { gatherSymbols: jest.fn() } as unknown as DataGatheringService,
        null,
        { emit: jest.fn() } as unknown as EventEmitter2,
        null,
        null,
        {
          $transaction: prismaTransaction,
          order: {
            update,
            findUnique: jest.fn().mockResolvedValue({
              id: 'activity-id',
              userId: activityOwner,
              type: activityType,
              SymbolProfile: {
                id: sourceProfileId,
                userId,
                dataSource: profileDataSource
              }
            })
          },
          symbolProfile: {
            findUnique: jest.fn().mockResolvedValue(
              profileExists
                ? {
                    id: assetProfileId,
                    symbol,
                    dataSource,
                    userId: profileOwner
                  }
                : null
            )
          }
        } as unknown as PrismaService,
        null,
        { validateTagIds: jest.fn() } as unknown as TagService
      );

      const request = {
        assetProfileId,
        assetProfileName,
        expectedAssetProfileId,
        preserveComment,
        data: {
          ...(comment !== undefined ? { comment } : {}),
          id: activityId,
          type,
          assetClass: AssetClass.COMMODITY,
          assetSubClass: AssetSubClass.PRECIOUS_METAL,
          date: parseDate('2024-01-01'),
          symbol,
          SymbolProfile: {
            connect: {
              dataSource_symbol: {
                dataSource,
                symbol
              }
            },
            update: {
              assetClass: AssetClass.COMMODITY,
              assetSubClass: AssetSubClass.PRECIOUS_METAL,
              name: symbol
            }
          }
        },
        originalDate: parseDate('2024-01-01'),
        userId: 'user-id',
        where: { id: 'activity-id' }
      };
      await service.updateActivity(request);

      return (update.mock.calls[0] as [Prisma.OrderUpdateArgs])[0].data;
    }
  });
});

function createActivity({
  assetSubClass,
  currency,
  dataSource = DataSource.YAHOO,
  date = '2020-01-01',
  quantity = 10,
  symbol,
  unitPrice = 100
}: {
  assetSubClass?: string;
  currency?: string;
  dataSource?: DataSource;
  date?: string;
  quantity?: number;
  symbol: string;
  unitPrice?: number;
}): Activity {
  return {
    ...activityDummyData,
    assetProfile: {
      ...assetProfileDummyData,
      assetSubClass,
      currency,
      dataSource,
      id: `${dataSource}-${symbol}-profile`,
      symbol
    },
    date: parseDate(date),
    quantity,
    type: 'BUY',
    unitPrice,
    unitPriceInAssetProfileCurrency: unitPrice,
    value: quantity * unitPrice,
    valueInBaseCurrency: quantity * unitPrice
  } as Activity;
}

function createSplit(
  dateString = '2021-01-01',
  numerator = 2,
  denominator = 1
): AssetProfileSplit {
  const date = parseDate(dateString);

  return {
    createdAt: date,
    date,
    denominator,
    id: `${dateString}-${numerator}-${denominator}`,
    numerator,
    symbolProfileId: 'YAHOO-AAPL-profile',
    updatedAt: date
  };
}
