import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException
} from '@nestjs/common';
import { Provider, TenantUserProvisioning, User } from '@prisma/client';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';

const ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_IV_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;

interface ProvisionTenantUserInput {
  tenantId: string;
  provisioningKey: string;
}

export interface ProvisionedTenantUser {
  userId: string;
  role: 'USER';
  accessToken: string;
}

@Injectable()
export class TenantProvisioningService {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService,
    private readonly userService: UserService
  ) {}

  public async provision({
    tenantId,
    provisioningKey
  }: ProvisionTenantUserInput): Promise<ProvisionedTenantUser> {
    if (!this.isUuid(tenantId) || !this.isUuid(provisioningKey)) {
      throw new ConflictException('Tenant provisioning conflict');
    }

    const encryptionKey = this.getEncryptionKey();
    const existing = await this.findBinding({ tenantId, provisioningKey });

    if (existing) {
      return this.replay(
        existing,
        { tenantId, provisioningKey },
        encryptionKey
      );
    }

    const userId = randomUUID();
    const { accessToken, hashedAccessToken } =
      this.userService.generateAccessToken({ userId });
    const encryptedAccessToken = this.encryptAccessToken({
      accessToken,
      encryptionKey,
      tenantId,
      provisioningKey,
      userId
    });

    try {
      return await this.prismaService.$transaction(async (transaction) => {
        const racedBinding = await transaction.tenantUserProvisioning.findFirst(
          {
            where: { OR: [{ tenantId }, { provisioningKey }] },
            include: { user: true }
          }
        );

        if (racedBinding) {
          return this.replay(
            racedBinding,
            { tenantId, provisioningKey },
            encryptionKey
          );
        }

        await this.userService.createUserWithDefaults(
          transaction,
          {
            id: userId,
            provider: Provider.ANONYMOUS,
            role: 'USER',
            accessToken: hashedAccessToken
          },
          undefined
        );

        await transaction.tenantUserProvisioning.create({
          data: {
            encryptedAccessToken: new Uint8Array(encryptedAccessToken),
            encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
            provisioningKey,
            tenantId,
            userId
          }
        });

        return { userId, role: 'USER', accessToken };
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        const winner = await this.findBinding({ tenantId, provisioningKey });

        if (winner) {
          return this.replay(
            winner,
            { tenantId, provisioningKey },
            encryptionKey
          );
        }

        throw new ConflictException('Tenant provisioning conflict');
      }

      throw new InternalServerErrorException('Tenant provisioning failed');
    }
  }

  private async findBinding({
    tenantId,
    provisioningKey
  }: ProvisionTenantUserInput): Promise<
    (TenantUserProvisioning & { user: User | null }) | null
  > {
    try {
      return await this.prismaService.tenantUserProvisioning.findFirst({
        where: { OR: [{ tenantId }, { provisioningKey }] },
        include: { user: true }
      });
    } catch {
      throw new InternalServerErrorException('Tenant provisioning failed');
    }
  }

  private replay(
    binding: TenantUserProvisioning & { user: User | null },
    { tenantId, provisioningKey }: ProvisionTenantUserInput,
    encryptionKey: Buffer
  ): ProvisionedTenantUser {
    if (
      binding.tenantId !== tenantId ||
      binding.provisioningKey !== provisioningKey
    ) {
      throw new ConflictException('Tenant provisioning conflict');
    }

    try {
      const user = binding.user;
      if (
        user?.provider !== Provider.ANONYMOUS ||
        user?.role !== 'USER' ||
        binding.encryptionKeyVersion !== ENCRYPTION_KEY_VERSION
      ) {
        throw new Error('invalid binding');
      }

      const accessToken = this.decryptAccessToken({
        ciphertext: binding.encryptedAccessToken,
        encryptionKey,
        tenantId,
        provisioningKey,
        userId: binding.userId
      });
      const storedVerifier = Buffer.from(user.accessToken ?? '', 'hex');
      const expectedVerifier = Buffer.from(
        this.userService.createAccessToken({
          password: accessToken,
          salt: this.configurationService.get('ACCESS_TOKEN_SALT')
        }),
        'hex'
      );

      if (
        storedVerifier.length !== expectedVerifier.length ||
        !timingSafeEqual(storedVerifier, expectedVerifier)
      ) {
        throw new Error('invalid verifier');
      }

      return { userId: user.id, role: 'USER', accessToken };
    } catch {
      throw new ConflictException('Tenant provisioning conflict');
    }
  }

  private getEncryptionKey(): Buffer {
    const configuredKey = this.configurationService.get(
      'TENANT_PROVISIONING_ENCRYPTION_KEY'
    );

    if (!configuredKey?.trim()) {
      throw new ServiceUnavailableException(
        'Tenant provisioning is unavailable'
      );
    }

    const encryptionKey = Buffer.from(configuredKey, 'base64');
    if (
      encryptionKey.length !== ENCRYPTION_KEY_BYTES ||
      encryptionKey.toString('base64') !== configuredKey
    ) {
      throw new ServiceUnavailableException(
        'Tenant provisioning is unavailable'
      );
    }

    return encryptionKey;
  }

  private encryptAccessToken({
    accessToken,
    encryptionKey,
    tenantId,
    provisioningKey,
    userId
  }: {
    accessToken: string;
    encryptionKey: Buffer;
    tenantId: string;
    provisioningKey: string;
    userId: string;
  }): Buffer {
    try {
      const iv = randomBytes(ENCRYPTION_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(
        this.getAdditionalAuthenticatedData({
          tenantId,
          provisioningKey,
          userId
        })
      );
      const ciphertext = Buffer.concat([
        cipher.update(accessToken, 'utf8'),
        cipher.final()
      ]);

      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    } catch {
      throw new InternalServerErrorException('Tenant provisioning failed');
    }
  }

  private decryptAccessToken({
    ciphertext,
    encryptionKey,
    tenantId,
    provisioningKey,
    userId
  }: {
    ciphertext: Uint8Array;
    encryptionKey: Buffer;
    tenantId: string;
    provisioningKey: string;
    userId: string;
  }): string {
    const envelope = Buffer.from(ciphertext);
    if (envelope.length <= ENCRYPTION_IV_BYTES + AUTHENTICATION_TAG_BYTES) {
      throw new Error('invalid ciphertext');
    }

    const iv = envelope.subarray(0, ENCRYPTION_IV_BYTES);
    const authenticationTag = envelope.subarray(
      ENCRYPTION_IV_BYTES,
      ENCRYPTION_IV_BYTES + AUTHENTICATION_TAG_BYTES
    );
    const encryptedToken = envelope.subarray(
      ENCRYPTION_IV_BYTES + AUTHENTICATION_TAG_BYTES
    );
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(
      this.getAdditionalAuthenticatedData({
        tenantId,
        provisioningKey,
        userId
      })
    );
    decipher.setAuthTag(authenticationTag);

    return Buffer.concat([
      decipher.update(encryptedToken),
      decipher.final()
    ]).toString('utf8');
  }

  private getAdditionalAuthenticatedData({
    tenantId,
    provisioningKey,
    userId
  }: {
    tenantId: string;
    provisioningKey: string;
    userId: string;
  }): Buffer {
    return Buffer.from(
      `${ENCRYPTION_KEY_VERSION}:${tenantId}:${provisioningKey}:${userId}`
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );
  }
}
