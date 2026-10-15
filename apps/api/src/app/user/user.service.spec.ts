import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { SubscriptionService } from '@ghostfolio/api/app/subscription/subscription.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { I18nService } from '@ghostfolio/api/services/i18n/i18n.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';

import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Prisma, Provider, Role } from '@prisma/client';

import { UserService } from './user.service';

describe('UserService transaction initialization', () => {
  it('creates the standard USD account and settings through the supplied transaction', async () => {
    const user: Prisma.UserCreateInput = {
      id: 'synthetic-provisioned-user',
      provider: Provider.ANONYMOUS,
      role: Role.USER,
      accessToken: 'synthetic-verifier'
    };
    const create = jest.fn().mockResolvedValue(user);
    const transaction = { user: { create } };
    const i18nService = {
      getTranslation: jest.fn().mockReturnValue('My Account')
    };
    const service = new UserService(
      {} as ActivitiesService,
      {} as ConfigurationService,
      {} as EventEmitter2,
      i18nService as unknown as I18nService,
      {} as PrismaService,
      {} as PropertyService,
      {} as SubscriptionService,
      {} as TagService,
      {} as ThrottlerStorage
    );

    await service.createUserWithDefaults(
      transaction as unknown as Prisma.TransactionClient,
      user,
      'en-US'
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        ...user,
        accounts: {
          create: { currency: 'USD', name: 'My Account' }
        },
        settings: {
          create: { settings: { currency: 'USD' } }
        }
      }
    });
    expect(i18nService.getTranslation).toHaveBeenCalledWith({
      id: 'myAccount',
      languageCode: 'en'
    });
  });
});

describe('UserService provisioned user deletion protection', () => {
  it.each(['synthetic-self-user', 'synthetic-admin-target'])(
    'rejects deletion of a provisioned user (%s) before removing dependents',
    async (userId) => {
      const activitiesDelete = jest.fn();
      const accessDeleteMany = jest.fn();
      const accountDeleteMany = jest.fn();
      const analyticsDelete = jest.fn();
      const settingsDelete = jest.fn();
      const userDelete = jest.fn();
      const service = new UserService(
        { deleteActivities: activitiesDelete } as unknown as ActivitiesService,
        {} as ConfigurationService,
        {} as EventEmitter2,
        {} as I18nService,
        {
          access: { deleteMany: accessDeleteMany },
          account: { deleteMany: accountDeleteMany },
          analytics: { delete: analyticsDelete },
          settings: { delete: settingsDelete },
          tenantUserProvisioning: {
            findUnique: jest.fn().mockResolvedValue({ userId })
          },
          user: { delete: userDelete }
        } as unknown as PrismaService,
        {} as PropertyService,
        {} as SubscriptionService,
        {} as TagService,
        {} as ThrottlerStorage
      );

      await expect(service.deleteUser({ id: userId })).rejects.toBeInstanceOf(
        ConflictException
      );
      expect(accessDeleteMany).not.toHaveBeenCalled();
      expect(accountDeleteMany).not.toHaveBeenCalled();
      expect(analyticsDelete).not.toHaveBeenCalled();
      expect(activitiesDelete).not.toHaveBeenCalled();
      expect(settingsDelete).not.toHaveBeenCalled();
      expect(userDelete).not.toHaveBeenCalled();
    }
  );
});
