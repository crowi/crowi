/// <reference lib="dom" />
/**
 * RFC-0006 Phase 3 — typed Hono client factory.
 *
 * Wraps the runtime `hc<AppType>(baseUrl)` call from `hono/client` with
 * the request-init plumbing the web app needs (auth header / pluggable
 * fetch). Exports an `AppType` that describes the Hono route surface
 * declared by every `createRoute(...)` in `@crowi/api-contract/contracts`.
 *
 * **AppType placement decision (Phase 3 build-order smoke test, see
 * `docs/migrations/0006-hono-context.md` §11 & §14)**:
 *
 * - **Option 1** (`@crowi/api-contract` imports `AppType` from
 *   `@crowi/api/hono`) **failed** the smoke test — `pnpm --filter
 *   @crowi/api-contract build` runs before `@crowi/api`'s `dist/` is
 *   emitted (workspace dep graph: `@crowi/api -> @crowi/api-contract`,
 *   not the reverse), so the dts compile cannot resolve
 *   `@crowi/api/hono`.
 *
 * - **Option 2 adopted**: `@crowi/api-contract` is the single source of
 *   truth for `AppType`. It builds a no-op Hono chain that mirrors the
 *   real route surface (every `createRoute(...)` exported by the
 *   contracts) and exports `AppType = typeof contractApp`. The real
 *   `@crowi/api` handler chain produces the same shape because both
 *   sides consume the same `createRoute` definitions, so the
 *   `hc<AppType>` client is type-safe against the real server.
 *
 * If the route-definition <-> handler-implementation match ever drifts
 * (e.g. a contract is registered here but never wired in `@crowi/api`),
 * runtime requests will 404 — covered by integration tests.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { hc } from 'hono/client';
import type { z } from 'zod';

import { appRoutes } from './contracts/app';
import type { AppInfoResponseSchema } from './schemas/app';

type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;

/**
 * Spec-only Hono chain mirroring the route surface every consumer must
 * be able to talk to. The handlers below never execute at runtime —
 * `@crowi/api` registers the real handlers — so they return schema-
 * conforming stub bodies purely to thread the response type through
 * `OpenAPIHono`'s per-route type accumulator. Phase 4 commits extend
 * this chain one resource at a time so `AppType` stays in lock-step
 * with the real `@crowi/api` chain.
 */
const contractApp = new OpenAPIHono().openapi(appRoutes.getAppInfoRoute, (c) => c.json({ title: null } satisfies AppInfoResponse, 200));

export type AppType = typeof contractApp;

/**
 * Default request init applied to every call unless the caller overrides
 * it. The `headers` shape matches Hono's `hc` (a plain record / async
 * supplier of one); `fetch` matches the fetch spec exactly.
 */
export interface ClientOptions {
  /** Extra default headers (e.g. `Authorization: Bearer ...`). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Pluggable fetch implementation (used by the web app to inject the
   * refresh-token loop). Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * Build a typed Hono client against the contract `AppType`.
 *
 * `baseUrl` should already include the `/api/v2` prefix because the
 * Hono `OpenAPIHono` chain is mounted there (see
 * `packages/api/src/routes/index.ts`).
 */
export const createClient = (baseUrl: string, options: ClientOptions = {}) =>
  hc<AppType>(baseUrl, {
    headers: options.headers,
    fetch: options.fetch,
  });

export type CrowiApiClient = ReturnType<typeof createClient>;
