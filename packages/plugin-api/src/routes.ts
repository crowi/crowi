import type { AppRouter } from '@ts-rest/core';

/**
 * Scope passed to `registerRoutes`. The plugin builds a ts-rest
 * contract describing its endpoints and registers handlers against
 * it. The runtime mounts the resulting router under
 * `/api/v2/plugins/<name>/*` so:
 *
 *   contract.testConnection { method: 'POST', path: '/test' }
 *
 * is reachable at `POST /api/v2/plugins/<plugin-name>/test`. The path
 * prefix is automatic — plugins write paths *relative* to their own
 * namespace and never overlap with core endpoints or each other.
 *
 * `implementation` is typed loosely (`Record<string, unknown>`) at this
 * layer so the contract surface stays server-agnostic — plugins may
 * import `AppRouteImplementation` from `@ts-rest/express` for stronger
 * types in their own code, but `@crowi/plugin-api` itself does not
 * depend on Express.
 */
export interface PluginRouterScope {
  /**
   * Register a ts-rest contract together with its handler
   * implementation. The runtime is responsible for the Express wiring
   * and for the `/api/v2/plugins/<name>/` path prefix; the plugin
   * supplies only the endpoint definitions and the handlers.
   */
  register<T extends AppRouter>(contract: T, implementation: Record<keyof T, unknown>): void;
}
