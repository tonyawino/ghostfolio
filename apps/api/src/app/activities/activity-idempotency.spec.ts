import { Logger } from '@nestjs/common';
import { DataSource } from '@prisma/client';

import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { createActivityRequestDigest } from './activity-idempotency';

const KEY = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = 'owner';
const ACTOR = 'authenticated-user';
const profile = {
  dataSource: DataSource.YAHOO,
  symbol: 'SYNTH',
  currency: 'USD'
};
const activity = {
  id: 'original',
  userId: OWNER,
  date: new Date('2026-01-01'),
  SymbolProfile: profile
};
const dto = () => ({
  date: '2026-01-01',
  currency: 'USD',
  dataSource: DataSource.YAHOO,
  symbol: 'SYNTH',
  type: 'BUY',
  quantity: 2,
  unitPrice: 3,
  fee: 1
});
const input = () => ({
  ...dto(),
  date: new Date('2026-01-01'),
  userId: OWNER,
  user: { connect: { id: OWNER } },
  SymbolProfile: {
    connectOrCreate: {
      create: profile,
      where: {
        dataSource_symbol: { dataSource: DataSource.YAHOO, symbol: 'SYNTH' }
      }
    }
  }
});
function controllerFixture() {
  const service = {
    createActivity: jest.fn().mockResolvedValue(activity),
    createActivityIdempotently: jest.fn().mockResolvedValue(activity)
  };
  const provider = {
    validateActivities: jest.fn().mockResolvedValue(undefined)
  };
  const gathering = { gatherSymbols: jest.fn().mockResolvedValue([]) };
  const controller = new ActivitiesController(
    service as never,
    {} as never,
    provider as never,
    gathering as never,
    { getSymbolProfiles: jest.fn().mockResolvedValue([profile]) } as never
  );
  return { controller, service, provider, gathering };
}
function serviceFixture(result: unknown = null, original: unknown = activity) {
  const prisma = {
    activityCreateIdempotency: {
      findUnique: jest.fn().mockResolvedValue(result)
    },
    order: {
      findUnique: jest.fn().mockResolvedValue(original),
      create: jest.fn()
    },
    $transaction: jest.fn()
  };
  const effects = { emit: jest.fn() };
  const gathering = { addJobToQueue: jest.fn().mockResolvedValue(undefined) };
  const service = Object.assign(Object.create(ActivitiesService.prototype), {
    prismaService: prisma,
    eventEmitter: effects,
    dataGatheringService: gathering
  });
  return { service, prisma, effects, gathering };
}

describe('activity create idempotency', () => {
  it('preserves legacy calls without the header', async () => {
    const { controller, service, provider } = controllerFixture();
    await controller.createActivity(dto() as never, { userId: OWNER } as never);
    expect(service.createActivity).toHaveBeenCalledTimes(1);
    expect(service.createActivityIdempotently).not.toHaveBeenCalled();
    expect(provider.validateActivities).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not-a-uuid',
    '',
    ` ${KEY}`,
    `${KEY},${KEY}`,
    [KEY],
    `${KEY.slice(0, -1)}g`
  ])(
    'rejects a malformed UUID header %p before validation or writes',
    async (header) => {
      const { controller, service, provider } = controllerFixture();
      await expect(
        controller.createActivity(
          dto() as never,
          { userId: OWNER } as never,
          header,
          { user: { id: ACTOR } } as never
        )
      ).rejects.toMatchObject({ status: 400 });
      expect(service.createActivity).not.toHaveBeenCalled();
      expect(provider.validateActivities).not.toHaveBeenCalled();
    }
  );

  it('keeps legacy create successful if its post-commit profile queue rejects', async () => {
    const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    try {
      const { service, prisma, gathering } = serviceFixture();
      prisma.order.create = jest.fn().mockResolvedValue(activity);
      service.tagService = {
        validateTagIds: jest.fn().mockResolvedValue(undefined)
      };
      gathering.addJobToQueue.mockRejectedValueOnce(
        new Error('synthetic queue failure')
      );
      await expect(service.createActivity(input())).resolves.toBe(activity);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps legacy controller successful if its post-commit historical queue rejects', async () => {
    const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    try {
      const { controller, gathering } = controllerFixture();
      gathering.gatherSymbols.mockRejectedValueOnce(
        new Error('synthetic historical queue failure')
      );
      await expect(
        controller.createActivity(dto() as never, { userId: OWNER } as never)
      ).resolves.toMatchObject({ id: activity.id });
    } finally {
      log.mockRestore();
    }
  });

  it('scopes a normalized UUID to the authenticated USER and binds the effective owner', async () => {
    const { controller, service, provider } = controllerFixture();
    await controller.createActivity(
      { ...dto(), userId: 'untrusted' } as never,
      { userId: OWNER } as never,
      KEY.toUpperCase(),
      { user: { id: ACTOR } } as never
    );
    expect(service.createActivityIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER,
        user: { connect: { id: OWNER } }
      }),
      expect.objectContaining({
        idempotencyKey: KEY,
        authenticatedUserId: ACTOR,
        beforeCreate: expect.any(Function)
      })
    );
    expect(provider.validateActivities).not.toHaveBeenCalled();
  });

  it('resolves a replay before mutable validation and repeats post-commit effects', async () => {
    const { service, prisma, effects, gathering } = serviceFixture();
    const request = input();
    // The digest is obtained from the actual normalized input, never from provider state.
    prisma.activityCreateIdempotency.findUnique.mockResolvedValue({
      requestDigest: createActivityRequestDigest(request as never),
      resultOrderId: activity.id
    });
    const beforeCreate = jest
      .fn()
      .mockRejectedValue(new Error('quota changed'));
    expect(
      await service.createActivityIdempotently(request, {
        idempotencyKey: KEY,
        authenticatedUserId: ACTOR,
        beforeCreate
      })
    ).toBe(activity);
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.activityCreateIdempotency.findUnique).toHaveBeenCalledWith({
      where: {
        userId_operation_key: {
          userId: ACTOR,
          operation: 'activity.create',
          key: KEY
        }
      }
    });
    expect(effects.emit).toHaveBeenCalledTimes(2);
    expect(gathering.addJobToQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ jobId: 'YAHOO-SYNTH' })
      })
    );
  });

  it('rejects a changed request with 409', async () => {
    const { service, prisma } = serviceFixture({
      requestDigest: 'different',
      resultOrderId: activity.id
    });
    await expect(
      service.createActivityIdempotently(input(), {
        idempotencyKey: KEY,
        authenticatedUserId: ACTOR
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retains a result tombstone and returns 410 after Order deletion', async () => {
    const { service, prisma } = serviceFixture(
      {
        requestDigest: createActivityRequestDigest(input() as never),
        resultOrderId: activity.id
      },
      null
    );
    await expect(
      service.createActivityIdempotently(input(), {
        idempotencyKey: KEY,
        authenticatedUserId: ACTOR
      })
    ).rejects.toMatchObject({ status: 410 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
