import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { ProvisionTenantUserDto } from './provision-tenant-user.dto';
import { TenantProvisioningAuthGuard } from './tenant-provisioning-auth.guard';
import {
  ProvisionedTenantUser,
  TenantProvisioningService
} from './tenant-provisioning.service';

@Controller({ path: 'internal/tenant-users', version: '1' })
@UseGuards(TenantProvisioningAuthGuard, ThrottlerGuard)
export class TenantProvisioningController {
  public constructor(
    private readonly tenantProvisioningService: TenantProvisioningService
  ) {}

  @Post()
  public async provision(
    @Body() { tenantId, provisioningKey }: ProvisionTenantUserDto
  ): Promise<ProvisionedTenantUser> {
    const { userId, role, accessToken } =
      await this.tenantProvisioningService.provision({
        tenantId,
        provisioningKey
      });

    return { userId, role, accessToken };
  }
}
