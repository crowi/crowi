import type { Context } from 'hono';

/**
 * HTTP method a plugin route can be mounted on. Kept to the verbs the
 * inbound-webhook + admin-action surface actually needs (RFC-0013 §4):
 * `POST` for Slack events / slash / interactivity + `@action` targets,
 * `GET` for OAuth callbacks + simple status endpoints.
 */
export type PluginRouteMethod = 'GET' | 'POST';

/**
 * A plugin route handler. It receives the raw Hono `Context` and returns
 * a `Response` (or a promise of one), exactly like a hand-written Hono
 * handler — the scope does **not** wrap it in a typed-route/validator
 * layer.
 *
 * **Raw body invariant** (RFC-0013 §8, a Slack hard requirement): the
 * route is a plain Hono route, NOT a `@hono/zod-openapi` route, so no
 * body-consuming validator runs ahead of the handler. `c.req.text()` /
 * `c.req.raw` therefore yield the *exact* bytes the client sent, which
 * the Slack signature check (`HMAC-SHA256` over `v0:{ts}:{rawBody}`)
 * depends on. `createJwtAuth` (installed on non-public routes) never
 * reads the body, so the invariant holds for authed routes too.
 */
export type PluginRouteHandler = (c: Context) => Response | Promise<Response>;

/** Per-route options passed alongside the handler. */
export interface PluginRouteOptions {
  /**
   * When `true`, the route is mounted **without** `createJwtAuth`, so it
   * is reachable by unauthenticated requests (Crowi-auth public). Use for
   * inbound webhooks that authenticate themselves out-of-band — e.g. the
   * Slack Events API endpoint, which is gated by Slack's request-signature
   * check rather than a Crowi session (RFC-0013 §8).
   *
   * Omitted / `false` mounts the route under `createJwtAuth`, so it
   * requires a valid Crowi JWT just like a core authenticated endpoint
   * (admin "Test connection" / `@action` targets, OAuth callbacks).
   */
  public?: boolean;
}

/**
 * Scope passed to `registerRoutes(scope, ctx)`. Lets a plugin contribute
 * HTTP routes that the runtime mounts at
 * `/api/v2/plugins/<plugin-name>/<path>` — the `<plugin-name>` path
 * segment guarantees that core endpoints and other plugins cannot
 * collide (RFC-0013 §4).
 *
 * The scope is built per-plugin inside `buildHonoApp` (the Hono app does
 * not exist yet when plugins activate at boot), so `<plugin-name>` is
 * already closed over — plugins only supply the sub-path.
 */
export interface PluginRouterScope {
  /**
   * Mount `handler` for `method` at `<path>` under this plugin's
   * namespace. `path` is relative to `/api/v2/plugins/<plugin-name>` and
   * should start with `/` (e.g. `route('POST', '/events', handler, {
   * public: true })` → `POST /api/v2/plugins/<name>/events`).
   *
   * Pass `{ public: true }` to bypass `createJwtAuth` for self-
   * authenticating inbound webhooks; omit it for routes that require a
   * Crowi session.
   */
  route(method: PluginRouteMethod, path: string, handler: PluginRouteHandler, opts?: PluginRouteOptions): void;
}
