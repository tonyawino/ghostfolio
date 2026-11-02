import { UserModule } from '@ghostfolio/api/app/user/user.module';
import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';
import {
  THROTTLE_DEFAULT_LIMIT,
  THROTTLE_DEFAULT_TTL
} from '@ghostfolio/common/config';

import { Module } from '@nestjs/common';
import {
  ThrottlerGuard,
  ThrottlerStorageService,
  getOptionsToken,
  getStorageToken
} from '@nestjs/throttler';

import { TenantProvisioningAuthGuard } from './tenant-provisioning-auth.guard';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { TenantProvisioningService } from './tenant-provisioning.service';

@Module({
  controllers: [TenantProvisioningController],
  imports: [ConfigurationModule, PrismaModule, UserModule],
  providers: [
    TenantProvisioningService,
    TenantProvisioningAuthGuard,
    ThrottlerGuard,
    // Local providers keep provisioning throttled independently of the
    // optional global limiter. No throttle configuration is exported.
    {
      provide: getOptionsToken(),
      useValue: [{ limit: THROTTLE_DEFAULT_LIMIT, ttl: THROTTLE_DEFAULT_TTL }]
    },
    {
      provide: getStorageToken(),
      useClass: ThrottlerStorageService
    }
  ]
})
export class TenantProvisioningModule {}
