/**
 * Scope passed to `registerRoutes`. The HTTP route contribution surface
 * for plugins is **not currently wired** to the runtime — it has never
 * been invoked end-to-end. RFC-0006 Phase 6 removed the framework
 * dependency that previously typed the contract argument; the API
 * surface is therefore a deliberate no-op stub until a follow-up RFC
 * redesigns plugin HTTP contribution on top of Hono.
 *
 * Plugins that declare a `registerRoutes` callback today see it
 * receive this scope and call `scope.register(...)` with arbitrary
 * arguments — both arguments are accepted as `unknown` and the call
 * is silently dropped. The type fixture exists so the public surface
 * of `@crowi/plugin-api` keeps compiling against existing plugin
 * sources (including the in-tree `__fixtures__/example-plugin.ts`)
 * without forcing every plugin to be updated in lockstep with Phase 6.
 */
export interface PluginRouterScope {
  /**
   * No-op register. Both arguments are typed as `unknown` because the
   * runtime never reads them; concrete shapes are reserved for the
   * follow-up RFC that wires plugin HTTP contribution onto Hono.
   */
  register(contract: unknown, implementation: unknown): void;
}
