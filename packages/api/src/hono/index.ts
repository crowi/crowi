/**
 * RFC-0006 Phase 3 — Hono application bootstrap.
 *
 * `buildHonoApp(crowi)` returns the runtime `OpenAPIHono` chain that
 * serves `/api/v2/*` requests. Each Phase 3+ resource adds its handlers
 * by calling `registerXRoutes(...)` against the running chain.
 *
 * **AppType placement**: `AppType` is re-exported from
 * `@crowi/api-contract/client` (option 2 — see the file header there).
 * The contract package builds a no-op Hono chain over the same
 * `createRoute(...)` definitions that the real handlers consume, so
 * the inferred type matches the runtime shape without `@crowi/api`
 * having to be built before `@crowi/api-contract`.
 */
import type Crowi from 'src/crowi';

import { createHonoApp } from './app';
import { registerAppRoutes } from './handlers/app';

export { createHonoApp, createJwtAdminRequired, createJwtAuth, defaultHook, honoOnError } from './app';
export type { CrowiHonoBindings } from './app';

/**
 * Build the Hono application chain.
 *
 * Phase 4 commits extend this chain by wrapping the previous return
 * value with the next `registerXRoutes(...)`. Keeping the entire chain
 * inside a single expression preserves OpenAPIHono's per-route type
 * accumulation, which keeps the contract `AppType` and the runtime
 * chain in lock-step.
 */
export const buildHonoApp = (crowi: Crowi) => registerAppRoutes(createHonoApp(), crowi);

// `AppType` lives in `@crowi/api-contract` (option 2 — see
// `packages/api-contract/src/client.ts` for the placement decision) so
// consumers can import it without depending on `@crowi/api`'s build
// artefacts.
export type { AppType } from '@crowi/api-contract';
