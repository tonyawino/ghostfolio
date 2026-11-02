import { HttpException, Logger } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { TenantProvisioningAuthGuard } from './tenant-provisioning-auth.guard';

describe('Tenant provisioning auth guard', () => {
  const token = 'synthetic-provisioning-secret-0123456789';
  const originalToken = process.env.TENANT_PROVISIONING_AUTH_TOKEN;

  function createContext(authorization?: string | string[]) {
    return new ExecutionContextHost([
      { headers: authorization === undefined ? {} : { authorization } }
    ]);
  }

  function getRejection(
    guard: TenantProvisioningAuthGuard,
    authorization?: string | string[]
  ) {
    try {
      guard.canActivate(createContext(authorization));
    } catch (error) {
      if (error instanceof HttpException) {
        return error;
      }

      throw error;
    }

    throw new Error('Expected provisioning auth to reject the request');
  }

  beforeEach(() => {
    process.env.TENANT_PROVISIONING_AUTH_TOKEN = token;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.TENANT_PROVISIONING_AUTH_TOKEN;
    } else {
      process.env.TENANT_PROVISIONING_AUTH_TOKEN = originalToken;
    }

    jest.restoreAllMocks();
  });

  it.each([undefined, '', ' \t\n'])(
    'Disables provisioning before any write when auth configuration is %p',
    (configuredToken) => {
      if (configuredToken === undefined) {
        delete process.env.TENANT_PROVISIONING_AUTH_TOKEN;
      } else {
        process.env.TENANT_PROVISIONING_AUTH_TOKEN = configuredToken;
      }

      const write = jest.fn();
      const guard = new TenantProvisioningAuthGuard();
      const context = createContext(`Bearer ${token}`);

      expect(() => {
        if (guard.canActivate(context)) {
          write();
        }
      }).toThrow(HttpException);
      expect(write).not.toHaveBeenCalled();
      expect(getRejection(guard, `Bearer ${token}`).getStatus()).toBe(404);
    }
  );

  it('Accepts the exact dedicated bearer credential', () => {
    expect(
      new TenantProvisioningAuthGuard().canActivate(
        createContext(`Bearer ${token}`)
      )
    ).toBe(true);
  });

  it.each([
    undefined,
    '',
    token,
    'Bearer',
    'Bearer ',
    `Basic ${token}`,
    `bearer ${token}`,
    ` Bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer\t${token}`,
    `Bearer ${token} `,
    `Bearer ${token}\n`,
    `Bearer ${token}, Bearer ${token}`,
    `Bearer ${'x'.repeat(token.length)}`,
    `Bearer ${token.slice(0, -1)}`,
    `Bearer ${token}x`,
    [`Bearer ${token}`, `Bearer ${token}`]
  ])('Rejects missing, incorrect, or malformed auth: %p', (authorization) => {
    const guard = new TenantProvisioningAuthGuard();
    const error = getRejection(guard, authorization);

    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toEqual({
      message: 'Unauthorized',
      statusCode: 401
    });
  });

  it('Checks byte lengths safely for a non-ASCII credential', () => {
    process.env.TENANT_PROVISIONING_AUTH_TOKEN = 'é'.repeat(token.length);

    expect(
      getRejection(
        new TenantProvisioningAuthGuard(),
        `Bearer ${token}`
      ).getStatus()
    ).toBe(401);
  });

  it('Keeps rejected credentials and configuration secrets out of errors and logs', () => {
    const logSpies = ['debug', 'error', 'fatal', 'log', 'verbose', 'warn'].map(
      (method: 'debug' | 'error' | 'fatal' | 'log' | 'verbose' | 'warn') => {
        return jest.spyOn(Logger.prototype, method).mockImplementation();
      }
    );
    const suppliedToken = 'synthetic-invalid-secret';
    const error = getRejection(
      new TenantProvisioningAuthGuard(),
      `Bearer ${suppliedToken}`
    );
    const serializedError = JSON.stringify(error);

    expect(serializedError).not.toContain(token);
    expect(serializedError).not.toContain(suppliedToken);
    expect(error.message).toBe('Unauthorized');

    for (const logSpy of logSpies) {
      expect(logSpy).not.toHaveBeenCalled();
    }
  });
});
