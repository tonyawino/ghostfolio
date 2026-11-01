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
        preserveComment: true
      })
    );

    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
    ).toEqual([]);
    expect(dto).toHaveProperty('assetProfileName', 'RENAMED');
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
      preserveComment: true,
      userId: 'user-id'
    });
    expect(request.data).not.toHaveProperty('assetProfileName');
    expect(request.data).not.toHaveProperty('preserveComment');
  });
});
