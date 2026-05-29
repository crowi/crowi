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
import type { Context, Next } from 'hono';
import type Crowi from 'src/crowi';

import { createHonoApp } from './app';
import { createCors } from './middleware/cors';
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
import { registerAttachmentStreamRoutes } from './handlers/attachment-stream';
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
import { registerInviteAcceptRoutes } from './handlers/inviteAccept';
import { registerPasswordResetRoutes } from './handlers/passwordReset';
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
  // RFC-0006 Phase 6 Sub-batch D — Hono is the sole HTTP host, so
  // this CORS apply is the only CORS layer in the process. The Express
  // bridge that previously also ran `cors()` is gone.
  //
  // `app.use('*', ...)` mutates the underlying Hono instance — it
  // doesn't extend the typed openapi chain — so we install before
  // any `register*Routes(...)` calls.
  base.use('*', createCors(crowi));
  const withApp = registerAppRoutes(base, crowi);
  const withInstaller = registerInstallerRoutes(withApp, crowi);
  const withTokenAuth = registerTokenAuthRoutes(withInstaller, crowi);
  // Public invite-acceptance (token is the credential) — register before
  // the auth-gated me/user routes.
  const withInviteAccept = registerInviteAcceptRoutes(withTokenAuth, crowi);
  // Public self-service password reset (token is the credential).
  const withPasswordReset = registerPasswordResetRoutes(withInviteAccept, crowi);
  const withMe = registerMeRoutes(withPasswordReset, crowi);
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
  // RFC-0006 Phase 6 Sub-batch D — raw streaming attachment routes
  // (`GET /attachments/by-key/:key`, `GET /attachments/:id`). Hono
  // native via `Readable.toWeb`, no Express bridge. Registers
  // alongside the JSON attachment routes; the literal `:id{24-hex}`
  // pattern keeps them disjoint from `/attachments/upload` /
  // `/attachments/:id/meta`. Mutates the underlying instance
  // (returns `app` unchanged-as-type), so registering after
  // `registerAttachmentRoutes` is fine — both share the same
  // jwt-auth broad apply.
  registerAttachmentStreamRoutes(withAttachment, crowi);
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

  // RFC-0006 Phase 6 — expose the runtime OpenAPI 3.1 document at
  // `/api/v2/openapi.json` and the Scalar API Reference UI at
  // `/api/v2/docs`. The doc is built from the handlers actually
  // registered above (vs. the bare scaffold in
  // `packages/api-contract/scripts/generate-openapi.ts` which emits the
  // commit-tracked artefact), so admins always see the live shape.
  //
  // We intentionally call `.doc31` / `.get` on the chained app for
  // their side-effect only — capturing the return type would extend
  // an already-TS2589-deep chain. The mutation registers the routes
  // on the same underlying Hono instance, which is what consumers
  // observe at runtime.
  //
  // Scalar (`@scalar/hono-api-reference`) is ESM-only with a `.js`
  // extension, which Jest's CJS runtime cannot statically parse. We
  // dynamic-import it from a lazy wrapper middleware so test files
  // that boot the api process don't trip a transform error. The
  // handler is registered eagerly; the import only runs on the first
  // `GET /api/v2/docs` request.
  withNotification.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Crowi API',
      description: 'API for Crowi - Markdown-based Wiki Application',
      version: '2.0.0',
    },
  });

  // Scalar's middleware is typed for a bare `Env`; our bindings carry
  // `Variables: { user: UserDocument }`. The two are compatible at
  // runtime (the handler ignores `c.var.user`), so we cast the import
  // result to a binding-agnostic shape to keep the chain clean.
  type LooseMiddleware = (c: Context, next: Next) => Promise<Response | void>;
  let scalarHandler: LooseMiddleware | null = null;
  withNotification.get('/docs', async (c, next) => {
    if (scalarHandler == null) {
      const { Scalar } = await import('@scalar/hono-api-reference');
      scalarHandler = Scalar({ url: '/api/v2/openapi.json' }) as unknown as LooseMiddleware;
    }
    return scalarHandler(c as Context, next);
  });

  return withNotification;
};

// `AppType` lives in `@crowi/api-contract` (option 2 — see
// `packages/api-contract/src/client.ts` for the placement decision) so
// consumers can import it without depending on `@crowi/api`'s build
// artefacts.
export type { AppType } from '@crowi/api-contract';
