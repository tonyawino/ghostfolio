import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { SubscriptionService } from '@ghostfolio/api/app/subscription/subscription.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { I18nService } from '@ghostfolio/api/services/i18n/i18n.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';

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
