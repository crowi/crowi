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
import { registerAdminCryptoRoutes } from './handlers/adminCrypto';
import { registerAdminAppRoutes } from './handlers/admin/app';
import { registerAdminAuthRoutes } from './handlers/admin/auth';
import { registerAdminMailRoutes } from './handlers/admin/mail';
import { registerAdminPluginsRoutes } from './handlers/admin/plugins';
import { registerAdminSearchRoutes } from './handlers/admin/search';
import { registerAdminSecurityRoutes } from './handlers/admin/security';
import { registerAdminShareRoutes } from './handlers/admin/share';
import { registerAdminStorageRoutes } from './handlers/admin/storage';
import { registerAdminUsersRoutes } from './handlers/admin/users';
import { registerAppRoutes } from './handlers/app';
import { registerAttachmentRoutes } from './handlers/attachment';
import { registerAutocompleteRoutes } from './handlers/autocomplete';
import { registerBacklinkRoutes } from './handlers/backlink';
import { registerBookmarkRoutes } from './handlers/bookmark';
import { registerCommentRoutes } from './handlers/comment';
import { registerDraftRoutes } from './handlers/draft';
import { registerInstallerRoutes } from './handlers/installer';
import { registerMeRoutes } from './handlers/me';
import { registerNotificationRoutes } from './handlers/notification';
import { registerPageRoutes } from './handlers/page';
import { registerPageCollabRoutes } from './handlers/page-collab';
import { registerPagePreviewRoutes } from './handlers/page-preview';
import { registerPresenceRoutes } from './handlers/presence';
import { registerRevisionRoutes } from './handlers/revision';
import { registerSearchRoutes } from './handlers/search';
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
  // Revision MUST register before page / page-preview / pageCollab /
  // presence: it owns the `app.use('/pages/*', createJwtAuth(crowi))`
  // broad apply, and the downstream `/pages/*` handlers rely on that
  // already-installed middleware (Hono does not dedupe middleware by
  // reference — re-installing would cost a second JWT verify +
  // User.findById per request).
  const withRevision = registerRevisionRoutes(withComment, crowi);
  const withPage = registerPageRoutes(withRevision, crowi);
  const withPagePreview = registerPagePreviewRoutes(withPage, crowi);
  // pageCollab (RFC-0003 wsToken) + presence (RFC-0005 token + likers)
  // both attach `/pages/{id}/<suffix>` endpoints under the shared
  // jwtAuth apply. presence depends on the same prefix as pageCollab
  // so we keep them grouped; their relative order is irrelevant to
  // routing (Hono dispatches by method+path) but mirrors the spec
  // chain in `packages/api-contract/src/client.ts`.
  const withPageCollab = registerPageCollabRoutes(withPagePreview, crowi);
  const withPresence = registerPresenceRoutes(withPageCollab, crowi);
  // Batch 6 — draft / autocomplete / attachment (RFC-0004). draft +
  // `/pages/autocomplete` ride on the revision-owned `/pages/*` jwtAuth
  // apply (same dedupe-avoidance rationale as page / page-preview /
  // pageCollab / presence). autocomplete installs jwtAuth on the
  // singleton `/users/autocomplete` literal itself; attachment installs
  // jwtAuth + rate-limit on `/attachments/*`. Rate limiting wraps the
  // two autocomplete endpoints (60/min) and `uploadAttachment` (20/min).
  const withDraft = registerDraftRoutes(withPresence, crowi);
  const withAutocomplete = registerAutocompleteRoutes(withDraft, crowi);
  const withAttachment = registerAttachmentRoutes(withAutocomplete, crowi);
  // Batch 7 — search. Singleton literal path `/search` (OUTSIDE the
  // revision-owned `/pages/*` apply). The handler installs jwtAuth on
  // the literal path itself, same single-route install pattern as
  // `/users/autocomplete`. No rate limit.
  const withSearch = registerSearchRoutes(withAttachment, crowi);
  // Batch 8 — adminCrypto. Two literal paths under `/admin/crypto/*`,
  // admin-only (first time `createJwtAdminRequired` lands on Hono).
  const withAdminCrypto = registerAdminCryptoRoutes(withSearch, crowi);
  // Batch 9 — the 9 admin sub-contracts (app / auth / security / mail /
  // share / storage / search / users / plugins). Each handler installs
  // `createJwtAdminRequired(crowi)` broadly on its `/admin/<sub>/*`
  // prefix + the bare `/admin/<sub>` path. No prefix overlap between
  // sub-contracts (every one owns a distinct second-segment literal),
  // so the broad apply pattern is safe.
  const withAdminApp = registerAdminAppRoutes(withAdminCrypto, crowi);
  const withAdminAuth = registerAdminAuthRoutes(withAdminApp, crowi);
  const withAdminSecurity = registerAdminSecurityRoutes(withAdminAuth, crowi);
  const withAdminMail = registerAdminMailRoutes(withAdminSecurity, crowi);
  const withAdminShare = registerAdminShareRoutes(withAdminMail, crowi);
  const withAdminStorage = registerAdminStorageRoutes(withAdminShare, crowi);
  const withAdminSearch = registerAdminSearchRoutes(withAdminStorage, crowi);
  const withAdminUsers = registerAdminUsersRoutes(withAdminSearch, crowi);
  const withAdminPlugins = registerAdminPluginsRoutes(withAdminUsers, crowi);
  const withNotification = registerNotificationRoutes(withAdminPlugins, crowi);
  return withNotification;
};

// `AppType` lives in `@crowi/api-contract` (option 2 — see
// `packages/api-contract/src/client.ts` for the placement decision) so
// consumers can import it without depending on `@crowi/api`'s build
// artefacts.
export type { AppType } from '@crowi/api-contract';
