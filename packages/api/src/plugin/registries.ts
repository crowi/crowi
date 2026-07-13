import type {
  AuthDriver,
  AuthRegistry,
  MailSender,
  MailSenderRegistry,
  NotifierDriver,
  NotifierRegistry,
  PluginRouteHandler,
  PluginRouteMethod,
  PluginRouteOptions,
  PluginRouterScope,
  SearchDriver,
  SearchRegistry,
  StorageDriver,
  StorageRegistry,
} from '@crowi/plugin-api';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';
import type { CrowiHonoBindings } from 'src/hono/app';
import { createJwtAdminRequired } from 'src/hono/middleware/admin';
import { createJwtAuth } from 'src/hono/middleware/auth';

/**
 * Generic backing registry for all the typed registries below. Each
 * registry stores `(driverName → driver)` and remembers which plugin
 * registered each entry so the runtime can give clear error messages
 * on collisions.
 */
export class DriverRegistry<T> {
  private drivers = new Map<string, { plugin: string; driver: T }>();

  constructor(private readonly kind: string) {}

  register(driverName: string, driver: T, registeringPlugin: string): void {
    const existing = this.drivers.get(driverName);
    if (existing) {
      throw new Error(`Plugin '${registeringPlugin}' tried to register ${this.kind} driver '${driverName}', but '${existing.plugin}' already did.`);
    }
    this.drivers.set(driverName, { plugin: registeringPlugin, driver });
  }

  get(driverName: string): T | undefined {
    return this.drivers.get(driverName)?.driver;
  }

  has(driverName: string): boolean {
    return this.drivers.has(driverName);
  }

  /**
   * Reverse lookup: the registered `(driverName, plugin)` for a driver
   * instance, or undefined. Lets handlers report the active driver's
   * name without re-implementing the identity scan.
   */
  entryOf(driver: T): { driverName: string; plugin: string } | undefined {
    for (const [driverName, entry] of this.drivers) {
      if (entry.driver === driver) return { driverName, plugin: entry.plugin };
    }
    return undefined;
  }

  list(): { driverName: string; plugin: string }[] {
    return Array.from(this.drivers.entries()).map(([driverName, { plugin }]) => ({ driverName, plugin }));
  }
}

/**
 * Per-plugin scope handed to `registerStorage(scope, ctx)`. Closes
 * over the registering plugin's name so we don't have to make plugins
 * pass it themselves on every call.
 */
export const makeStorageScope = (registry: DriverRegistry<StorageDriver>, plugin: string): StorageRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeSearchScope = (registry: DriverRegistry<SearchDriver>, plugin: string): SearchRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeAuthScope = (registry: DriverRegistry<AuthDriver>, plugin: string): AuthRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeNotifierScope = (registry: DriverRegistry<NotifierDriver>, plugin: string): NotifierRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeMailScope = (registry: DriverRegistry<MailSender>, plugin: string): MailSenderRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

/**
 * Per-plugin scope handed to `registerRoutes(scope, ctx)`. Unlike the
 * driver scopes above (which only close over a name + a registry), this
 * one mutates the live Hono app: every `scope.route(...)` mounts a route
 * on `app`'s underlying instance at `/plugins/<plugin>/<path>` (the
 * `/api/v2` prefix is stripped at the listener boundary, so the route
 * answers at `/api/v2/plugins/<plugin>/<path>`).
 *
 * The `<plugin>` npm name becomes a path segment as-is — npm names allow
 * `/` (`@crowi/plugin-slack`) but Hono treats each `/`-delimited piece as
 * a static segment, so the namespace still guarantees collision-freedom
 * against core endpoints and other plugins (RFC-0013 §4).
 *
 * Routes are mounted **directly on the underlying Hono instance** (the
 * same side-effect-mutate pattern as `attachMcp` /
 * `registerAttachmentStreamRoutes`) rather than on the typed
 * `@hono/zod-openapi` chain: plugin routes are plain Hono routes with no
 * request/response contract, so they neither extend `CrowiApiClient` nor
 * appear in the OpenAPI document. Keeping them off the typed chain also keeps
 * the body un-consumed by any validator, preserving the raw-body
 * invariant the Slack signature check depends on (RFC-0013 §8).
 *
 * `opts.auth` selects the authorization tier installed on that exact path
 * (the per-path install mirrors `oauth.ts`'s public-vs-authed handling):
 * `'public'` mounts the route bare, `'user'` (the default when `opts` is
 * omitted) installs `createJwtAuth(crowi)`, and `'admin'` installs
 * `createJwtAdminRequired(crowi)` — the same middleware every `/admin/*`
 * handler uses, so a plugin's admin-tier route enforces `user.admin ===
 * true` identically to a core admin endpoint.
 */
export const makePluginRouterScope = (app: OpenAPIHono<CrowiHonoBindings>, crowi: Crowi, plugin: string): PluginRouterScope => {
  const mountPath = (path: string): string => {
    // Tolerate a missing leading slash so `route('POST', 'events', …)`
    // and `route('POST', '/events', …)` both land at the same place.
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `/plugins/${plugin}${suffix}`;
  };

  return {
    route(method: PluginRouteMethod, path: string, handler: PluginRouteHandler, opts?: PluginRouteOptions): void {
      const fullPath = mountPath(path);
      const auth = opts?.auth ?? 'user';
      if (auth === 'admin') {
        app.use(fullPath, createJwtAdminRequired(crowi));
      } else if (auth === 'user') {
        app.use(fullPath, createJwtAuth(crowi));
      }
      // auth === 'public': no middleware installed — public webhooks
      // authenticate themselves out-of-band, e.g. Slack request signing.
      // The handler is a plain `(c) => Response` — register it on the
      // underlying instance for the requested verb. `app.on(method, …)`
      // takes the method as a string so both verbs share one code path.
      app.on(method, fullPath, handler);
    },
  };
};
