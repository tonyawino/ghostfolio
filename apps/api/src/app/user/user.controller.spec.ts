import { ImpersonationGuard } from '@ghostfolio/api/guards/impersonation.guard';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import type {
  ImpersonationContext,
  RequestWithUser
} from '@ghostfolio/common/types';

import { HttpException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA
} from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from '@nestjs/passport';
import { StatusCodes } from 'http-status-codes';

import { UserController } from './user.controller';
import { UserService } from './user.service';

// Imported services use packages which Jest cannot load as ESM.
jest.mock('@openrouter/ai-sdk-provider', () => ({}));
jest.mock('ai', () => ({}));

describe('UserController identity', () => {
  const user = {
    id: 'authenticated-token-principal',
    role: 'USER',
    accounts: [{ id: 'private-account' }],
    activities: [{ id: 'private-activity' }],
    holdings: [{ symbol: 'private-holding' }],
    permissions: ['private-permission'],
    settings: { settings: { baseCurrency: 'EUR' } },
    subscription: { type: 'private-subscription' }
  };
  const ownContext: ImpersonationContext = {
    isActive: false,
    scopes: [],
    userId: user.id,
    userSettings: {}
  };

  let controller: UserController;

  beforeEach(() => {
    // Empty dependencies make any service or database call fail the test.
    controller = new UserController(
      {} as ConfigurationService,
      {} as JwtService,
      {} as PrismaService,
      {} as PropertyService,
      { user } as unknown as RequestWithUser,
      {} as UserService
    );
  });

  it('Returns exactly the authenticated token principal id and role', () => {
    const identity = controller.getIdentity(ownContext);

    expect(identity).toEqual({ id: user.id, role: user.role });
    expect(Object.keys(identity).sort()).toEqual(['id', 'role']);
    expect(identity).not.toBe(user);
  });

  it('Rejects active impersonation with 403 instead of returning either identity', () => {
    const context = {
      ...ownContext,
      isActive: true,
      userId: 'impersonated-user'
    };

    expect(() => controller.getIdentity(context)).toThrow(
      expect.objectContaining({
        status: StatusCodes.FORBIDDEN
      }) as HttpException
    );
  });

  it('Exposes GET user/identity behind JWT auth and the impersonation guard in order', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Inspect metadata without invoking the handler.
    const handler = UserController.prototype.getIdentity;

    expect(Reflect.getMetadata(PATH_METADATA, UserController)).toBe('user');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('identity');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      AuthGuard('jwt'),
      ImpersonationGuard
    ]);
  });
});
