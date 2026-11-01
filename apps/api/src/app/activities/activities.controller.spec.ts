// sort-imports-ignore
import 'reflect-metadata';

import { SYMBOL_MAXIMUM_LENGTH } from '@ghostfolio/common/config';
import { UpdateOrderDto } from '@ghostfolio/common/dtos';
import { ImpersonationContext } from '@ghostfolio/common/types';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

describe('ActivitiesController explicit update options', () => {
  function updateBody(options: Record<string, unknown> = {}) {
    return {
      accountId: 'account-id',
      currency: 'USD',
      dataSource: 'MANUAL',
      date: '2024-01-01',
      fee: 0,
      id: 'activity-id',
      quantity: 1,
      symbol: 'profile-uuid',
      type: 'BUY',
      unitPrice: 100,
      ...options
    };
  }

  it('accepts and trims an explicit display name and comment-preservation option', async () => {
    const dto = plainToInstance(
      UpdateOrderDto,
      updateBody({
        assetProfileName: ' RENAMED ',
        expectedAssetProfileId: '7b9c2fb8-b593-4d3e-b5f7-8263b6cb77ee',
        preserveComment: true
      })
    );

    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
    ).toEqual([]);
    expect(dto).toHaveProperty('assetProfileName', 'RENAMED');
  });

  it('accepts an exact existing asset profile UUID', async () => {
    const dto = plainToInstance(
      UpdateOrderDto,
      updateBody({
        assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
        type: 'SELL'
      })
    );

    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
    ).toEqual([]);
  });

  it('rejects a malformed asset profile UUID', async () => {
    const dto = plainToInstance(
      UpdateOrderDto,
      updateBody({ assetProfileId: 'not-a-uuid', type: 'SELL' })
    );

    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'assetProfileId' })
      ])
    );
  });

  it('rejects a malformed expected source profile UUID', async () => {
    const dto = plainToInstance(
      UpdateOrderDto,
      updateBody({ expectedAssetProfileId: 'not-a-uuid' })
    );
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'expectedAssetProfileId' })
      ])
    );
  });

  it.each(['', '   ', null, 1, 'x'.repeat(SYMBOL_MAXIMUM_LENGTH + 1)])(
    'rejects an invalid explicit profile name: %j',
    async (assetProfileName) => {
      const dto = plainToInstance(
        UpdateOrderDto,
        updateBody({ assetProfileName })
      );

      expect(
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'assetProfileName' })
        ])
      );
    }
  );

  it.each(['true', null, 1])(
    'rejects a non-boolean preservation option: %j',
    async (preserveComment) => {
      const dto = plainToInstance(
        UpdateOrderDto,
        updateBody({ preserveComment })
      );

      expect(
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'preserveComment' })
        ])
      );
    }
  );

  it('passes explicit options separately from Prisma activity data', async () => {
    const service = {
      order: jest.fn().mockResolvedValue({ date: new Date('2024-01-01') }),
      updateActivity: jest.fn().mockResolvedValue({ id: 'activity-id' })
    };
    const controller = new ActivitiesController(
      service as unknown as ActivitiesService,
      null,
      null,
      null,
      null
    );
    const data = plainToInstance(
      UpdateOrderDto,
      updateBody({
        assetProfileName: 'RENAMED',
        expectedAssetProfileId: '7b9c2fb8-b593-4d3e-b5f7-8263b6cb77ee',
        preserveComment: true
      })
    );

    await controller.updateActivity(
      data,
      { userId: 'user-id' } as ImpersonationContext,
      'activity-id'
    );

    const request = service.updateActivity.mock.calls[0][0];
    expect(request).toMatchObject({
      assetProfileName: 'RENAMED',
      expectedAssetProfileId: '7b9c2fb8-b593-4d3e-b5f7-8263b6cb77ee',
      preserveComment: true,
      userId: 'user-id'
    });
    expect(request.data).not.toHaveProperty('assetProfileName');
    expect(request.data).not.toHaveProperty('expectedAssetProfileId');
    expect(request.data).not.toHaveProperty('preserveComment');
  });

  it('passes the verified profile UUID separately from Prisma activity data', async () => {
    const service = {
      order: jest.fn().mockResolvedValue({ date: new Date('2024-01-01') }),
      updateActivity: jest.fn().mockResolvedValue({ id: 'activity-id' })
    };
    const controller = new ActivitiesController(
      service as unknown as ActivitiesService,
      null,
      null,
      null,
      null
    );
    const data = plainToInstance(
      UpdateOrderDto,
      updateBody({
        assetProfileId: 'd90f1f59-6ebf-4aa2-9e62-1e576dd8d92a',
        type: 'SELL'
      })
    );

    await controller.updateActivity(
      data,
      { userId: 'user-id' } as ImpersonationContext,
      'activity-id'
    );

    const request = service.updateActivity.mock.calls[0][0];
    expect(request.assetProfileId).toBe('d90f1f59-6ebf-4aa2-9e62-1e576dd8d92a');
    expect(request.data).not.toHaveProperty('assetProfileId');
  });
});
