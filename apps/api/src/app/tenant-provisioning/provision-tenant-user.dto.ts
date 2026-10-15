import { IsDefined, IsUUID, Length } from 'class-validator';

export class ProvisionTenantUserDto {
  @IsDefined()
  @IsUUID()
  @Length(36, 36)
  tenantId: string;

  @IsDefined()
  @IsUUID()
  @Length(36, 36)
  provisioningKey: string;
}
