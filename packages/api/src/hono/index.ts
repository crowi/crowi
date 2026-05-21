/**
 * RFC-0006 Phase 3+ — Hono application bootstrap.
 *
 * `buildHonoApp(crowi)` returns the runtime `OpenAPIHono` chain that
 * serves `/api/v2/*` requests. Each migrated resource adds its handlers
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
import { registerBacklinkRoutes } from './handlers/backlink';
import { registerBookmarkRoutes } from './handlers/bookmark';
import { registerCommentRoutes } from './handlers/comment';
import { registerInstallerRoutes } from './handlers/installer';
import { registerMeRoutes } from './handlers/me';
import { registerRevisionRoutes } from './handlers/revision';
import { registerTokenAuthRoutes } from './handlers/tokenAuth';
import { registerUserRoutes } from './handlers/user';

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
 *
 * Order doesn't affect routing (Hono dispatches by `method + path`) but
 * we keep it aligned with the contract stub chain in
 * `packages/api-contract/src/client.ts` so the two are easy to eyeball
 * for drift.
 */
export const buildHonoApp = (crowi: Crowi) => {
  const base = createHonoApp();
  const withApp = registerAppRoutes(base, crowi);
  const withInstaller = registerInstallerRoutes(withApp, crowi);
  const withTokenAuth = registerTokenAuthRoutes(withInstaller, crowi);
  const withMe = registerMeRoutes(withTokenAuth, crowi);
  const withUser = registerUserRoutes(withMe, crowi);
  const withBookmark = registerBookmarkRoutes(withUser, crowi);
  const withBacklink = registerBacklinkRoutes(withBookmark, crowi);
  const withComment = registerCommentRoutes(withBacklink, crowi);
  const withRevision = registerRevisionRoutes(withComment, crowi);
  return withRevision;
};

// `AppType` lives in `@crowi/api-contract` (option 2 — see
// `packages/api-contract/src/client.ts` for the placement decision) so
// consumers can import it without depending on `@crowi/api`'s build
// artefacts.
export type { AppType } from '@crowi/api-contract';
