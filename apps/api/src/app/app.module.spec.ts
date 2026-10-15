import {
  DynamicModule,
  ForwardReference,
  RequestMethod,
  Type
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA
} from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { AppModule } from './app.module';
import { TenantProvisioningAuthGuard } from './tenant-provisioning/tenant-provisioning-auth.guard';

// The packages are ECMAScript modules, which Jest cannot load
jest.mock('@openrouter/ai-sdk-provider', () => {
  return {};
});
jest.mock('ai', () => {
  return {};
});

type ModuleDefinition =
  DynamicModule | ForwardReference<() => Type> | Promise<DynamicModule> | Type;

/**
 * The routes of the controllers which answer a request without the
 * authentication of a user, an API key, or the private provisioner, sorted by
 * the request method and the path. A new route must apply an appropriate auth
 * guard (e.g. via RequiresScope) or be explicitly reviewed as public here.
 *
 * The MCP transport, Bull Board and the static files are not covered, as they
 * are not served by a controller
 */
const PUBLIC_ROUTES = [
  'GET /asset/:dataSource/:symbol',
  'GET /assets/:languageCode/site.webmanifest',
  'GET /auth/google',
  'GET /auth/google/callback',
  'GET /auth/oidc',
  'GET /auth/oidc/callback',
  'GET /benchmarks',
  'GET /health',
  'GET /health/ai',
  'GET /health/data-enhancer/:name',
  'GET /health/data-provider/:dataSource',
  'GET /health/liveness',
  'GET /info',
  'GET /logo',
  'GET /logo/:dataSource/:symbol',
  'GET /public/:accessId/portfolio',
  'GET /sitemap.xml',
  'GET /subscription/stripe/callback',
  'POST /auth/anonymous',
  'POST /auth/webauthn/generate-authentication-options',
  'POST /auth/webauthn/verify-authentication',
  'POST /user'
];

const PRIVATE_PROVISIONING_ROUTES = ['POST /internal/tenant-users'];

/**
 * Gives the controllers of the module and of each module which it imports
 */
async function getControllers(
  moduleDefinition: ModuleDefinition,
  visitedModules = new Set<DynamicModule | Type>()
): Promise<Type[]> {
  const resolvedModule = await ('forwardRef' in moduleDefinition
    ? moduleDefinition.forwardRef()
    : moduleDefinition);

  if (visitedModules.has(resolvedModule)) {
    return [];
  }

  visitedModules.add(resolvedModule);

  const isDynamicModule = 'module' in resolvedModule;

  const controllers = [
    ...(isDynamicModule
      ? (resolvedModule.controllers ?? [])
      : ((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, resolvedModule) ??
          []) as Type[]))
  ];

  const importedModules = isDynamicModule
    ? [resolvedModule.module, ...(resolvedModule.imports ?? [])]
    : ((Reflect.getMetadata(MODULE_METADATA.IMPORTS, resolvedModule) ??
        []) as ModuleDefinition[]);

  for (const importedModule of importedModules) {
    controllers.push(...(await getControllers(importedModule, visitedModules)));
  }

  return [...new Set(controllers)];
}

/**
 * Gives the paths which the decorator of a controller or of a route sets
 */
function getPaths(target: object) {
  return [
    (Reflect.getMetadata(PATH_METADATA, target) ?? '') as string | string[]
  ].flat();
}

/**
 * Gives each controller route and its guards, including guards on its class.
 */
function getRoutes(controller: Type) {
  const routeHandlersByName = controller.prototype as Record<string, object>;

  return new MetadataScanner()
    .getAllMethodNames(routeHandlersByName)
    .flatMap((methodName) => {
      const routeHandler = routeHandlersByName[methodName];
      const requestMethod = Reflect.getMetadata(
        METHOD_METADATA,
        routeHandler
      ) as RequestMethod | undefined;

      if (requestMethod === undefined) {
        return [];
      }

      const guards = [controller, routeHandler].flatMap((target) => {
        return (Reflect.getMetadata(GUARDS_METADATA, target) ??
          []) as unknown[];
      });

      return getPaths(controller).flatMap((controllerPath) => {
        return getPaths(routeHandler).map((routePath) => {
          const path = `${controllerPath}/${routePath}`
            .split('/')
            .filter(Boolean)
            .join('/');

          return { guards, path: `${RequestMethod[requestMethod]} /${path}` };
        });
      });
    });
}

describe('AppModule', () => {
  it('should require the authentication for each route which is not public', async () => {
    const controllers = await getControllers(AppModule);
    const authenticationGuards: unknown[] = [
      AuthGuard('api-key'),
      AuthGuard('jwt'),
      TenantProvisioningAuthGuard
    ];

    const routesWithoutAuthentication = controllers
      .flatMap(getRoutes)
      .filter(({ guards }) => {
        return !guards.some((guard) => authenticationGuards.includes(guard));
      })
      .map(({ path }) => path)
      .sort();

    expect(routesWithoutAuthentication).toEqual(PUBLIC_ROUTES);
  });

  it('Requires private provisioning authentication for the internal tenant-user route', async () => {
    const controllers = await getControllers(AppModule);
    const privateRoutes = controllers
      .flatMap(getRoutes)
      .filter(({ guards }) => guards.includes(TenantProvisioningAuthGuard))
      .map(({ path }) => path)
      .sort();

    expect(privateRoutes).toEqual(PRIVATE_PROVISIONING_ROUTES);
    for (const route of PRIVATE_PROVISIONING_ROUTES) {
      expect(PUBLIC_ROUTES).not.toContain(route);
    }
  });
});
