import { getRequest } from '@ghostfolio/api/helper/execution-context.helper';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class TenantProvisioningAuthGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const configuredToken = process.env.TENANT_PROVISIONING_AUTH_TOKEN;

    if (!configuredToken?.trim()) {
      throw new NotFoundException();
    }

    const request = getRequest<{
      headers?: { authorization?: string | string[] };
    }>(context);
    const authorization = request?.headers?.authorization;

    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    ) {
      throw new UnauthorizedException();
    }

    const suppliedToken = authorization.slice('Bearer '.length);

    if (!suppliedToken || /\s/.test(suppliedToken)) {
      throw new UnauthorizedException();
    }

    const expectedBytes = Buffer.from(configuredToken, 'utf8');
    const suppliedBytes = Buffer.from(suppliedToken, 'utf8');

    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
