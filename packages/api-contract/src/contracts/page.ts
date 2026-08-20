/**
 * RFC-0006 Phase 4 Batch 4 — `page` resource ported to
 * `@hono/zod-openapi` route definitions. 14 endpoints — the largest
 * single resource in the API. Wire-format parity with the ts-rest era
 * is preserved.
 *
 * Auth: every endpoint requires JWT auth, but the Hono handler does
 * NOT install `createJwtAuth(crowi)` itself — the `revision` handler
 * already applies `app.use('/pages/*', createJwtAuth(crowi))` on the
 * shared chain (see `packages/api/src/hono/handlers/revision.ts`).
 * Hono does **not** dedupe middleware by reference, so re-installing
 * the same factory output on `/pages/*` would run JWT verify and
 * `User.findById` twice per request. The runtime contract is "register
 * `registerRevisionRoutes` before `registerPageRoutes` in `buildHonoApp`".
 *
 * Route-order considerations:
 *
 *  - `/pages/list`, `/pages/grant`, `/pages/seen`, `/pages/seen-users`,
 *    `/pages/like`, `/pages/unlike`, `/pages/watch`, `/pages/revert`,
 *    `/pages/rename`, `/pages/preview` are all literal sub-paths of
 *    `/pages`. They share the prefix `/pages/` with the revision
 *    routes (`/pages/{page_id}/revisions`, `/pages/revisions`,
 *    `/pages/revisions/{id}`) but Hono's pattern matcher dispatches
 *    by `method + full path` so there's no ambiguity:
 *      - GET /pages          (this contract — `getPage`)
 *      - GET /pages/list     (this contract — `listPages`)
 *      - GET /pages/revisions  (revision contract — list-by-ids)
 *      - GET /pages/{page_id}/revisions (revision — list-by-page)
 *  - `getPage` (`GET /pages`) and `createPage` (`POST /pages`) share
 *    the same path with different methods — Hono routes by `method+path`
 *    so this is fine.
 *  - `previewPage` (`POST /pages/preview`) lives in the `pagePreview`
 *    contract (separate file) but is also on `/pages/*` so it goes
 *    through the same `createJwtAuth` apply installed by `revision`.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';
// Shared with `GET /pages/autocomplete` — same per-user fixed-window
// limiter envelope, reused verbatim (see claimPageLinkAccessRoute's 429
// below) so the wire shape isn't duplicated across resources.
import { AutocompleteRateLimitErrorSchema } from '../schemas/autocomplete';
import { InsufficientScopeErrorSchema } from '../schemas/oauth';
import {
  ClaimPageLinkAccessResponseSchema,
  CreatePageRequestSchema,
  GetPageRequestSchema,
  GetPageResponseSchema,
  GetSeenUsersRequestSchema,
  GetWatchStatusRequestSchema,
  ListPageChildrenRequestSchema,
  ListPageChildrenResponseSchema,
  ListPagesRequestSchema,
  ListPagesResponseSchema,
  IdempotencyKeyConflictErrorSchema,
  IdempotencyKeyRequiredErrorSchema,
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
  PageRevisionErrorSchema,
  PageSchema,
  PageTransitionInProgressErrorSchema,
  PageTransitionIncompleteErrorSchema,
  RenamePageRequestSchema,
  RenamePageResponseSchema,
  RenameSubtreeRequestSchema,
  RenameSubtreeResponseSchema,
  RenameTreeErrorSchema,
  RevertToRevisionRequestSchema,
  SeenPageRequestSchema,
  SeenUsersResponseSchema,
  SetPageGrantRequestSchema,
  SetWatchStatusRequestSchema,
  UpdatePageRequestSchema,
  WatchStatusResponseSchema,
} from '../schemas/page';

// Generic 400 envelope shared by createPage / updatePage / deletePage /
// renamePage / revertDeletedPage / setPageGrant. The error `code` is a
// resource-specific literal (PAGE_EXISTS, PAGE_INVALID_NAME,
// PAGE_NOT_GRANTED — actually 403 not 400 — PAGE_CREATE_FAILED, etc.),
// so we leave both fields as free strings rather than enumerating them.
const PageBadRequestErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// Delete body — mirrors the ts-rest contract one-shot inline schema.
const DeletePageRequestSchema = z.object({
  page_id: z.string(),
  revision_id: z.string().optional(),
  completely: z.boolean().optional(),
});

const RevertDeletedPageRequestSchema = z.object({
  page_id: z.string(),
});

const PageIdBodySchema = z.object({
  page_id: z.string(),
});

const PageResponseSchema = z.object({ page: PageSchema });

export const getPageRoute = createRoute({
  method: 'get',
  path: '/pages',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Get page data by path or page_id',
  request: {
    query: GetPageRequestSchema,
  },
  responses: {
    200: {
      description:
        'The requested page with populated revision. `revision.renderedAst` shape is content-negotiated via the `X-Crowi-Ast-Version` request header (RFC-0023): requests declaring `X-Crowi-Ast-Version: 1` receive the typed `{astVersion, root}` envelope; all other requests receive the stored bare mdast Root verbatim. The response varies on this header (`Vary: X-Crowi-Ast-Version`).',
      content: { 'application/json': { schema: GetPageResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Caller cannot access the page',
      content: { 'application/json': { schema: PageNotGrantedErrorSchema } },
    },
    404: {
      description: 'Page not found',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    // feature-live-page-sync-reconcile — separates a genuine unknown-error
    // 500 (e.g. a transient render-artifact / renderer failure) from the
    // not-found/not-granted 404/403 branches above, so a reconcile head-GET
    // can tell "page is really gone/forbidden" from "read failed, try
    // again later" (see `packages/api/src/hono/handlers/page.ts`'s split catch).
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const listPagesRoute = createRoute({
  method: 'get',
  path: '/pages/list',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'List pages by path or creator (paginated)',
  request: {
    query: ListPagesRequestSchema,
  },
  responses: {
    200: {
      description:
        'Page list (newest first) with optional portal page and an accurate `total` (the full, unpaginated count of the same viewer-visible set `pages` is a page of). The portal document is the only row carrying `revision.renderedAst`; its shape is content-negotiated via the `X-Crowi-Ast-Version` request header (RFC-0023, same semantics as GET /pages). The response varies on this header (`Vary: X-Crowi-Ast-Version`).',
      content: { 'application/json': { schema: ListPagesResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const listPageChildrenRoute = createRoute({
  method: 'get',
  path: '/pages/children',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'List immediate child segments under a portal path (sidebar tree)',
  request: {
    query: ListPageChildrenRequestSchema,
  },
  responses: {
    200: {
      description: 'First-level child segments (alphabetical) under the path',
      content: { 'application/json': { schema: ListPageChildrenResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const createPageRoute = createRoute({
  method: 'post',
  path: '/pages',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Create a new page',
  request: {
    body: {
      content: { 'application/json': { schema: CreatePageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The created page with populated revision',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'Invalid request (PAGE_INVALID_NAME / PAGE_EXISTS / NON_EXISTENT_USER_PAGE / PAGE_CREATE_FAILED / INVALID_GRANT)',
      content: { 'application/json': { schema: PageBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const updatePageRoute = createRoute({
  method: 'put',
  path: '/pages',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Update existing page',
  request: {
    body: {
      content: { 'application/json': { schema: UpdatePageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The updated page with new revision',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'Invalid request (PAGE_UPDATE_FAILED / INVALID_GRANT)',
      content: { 'application/json': { schema: PageBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    409: {
      description: 'Stale revision_id (someone else updated the page)',
      content: { 'application/json': { schema: PageRevisionErrorSchema } },
    },
  },
});

export const setPageGrantRoute = createRoute({
  method: 'put',
  path: '/pages/grant',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Update page grant (visibility) only — no revision pushed',
  request: {
    body: {
      content: { 'application/json': { schema: SetPageGrantRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The page with the updated grant',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'Invalid request (INVALID_GRANT / PAGE_GRANT_UPDATE_FAILED)',
      content: { 'application/json': { schema: PageBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const seenPageRoute = createRoute({
  method: 'post',
  path: '/pages/seen',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Mark a page as seen by the current user (idempotent)',
  request: {
    body: {
      content: { 'application/json': { schema: SeenPageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The current seen-users list and count',
      content: { 'application/json': { schema: SeenUsersResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const getSeenUsersRoute = createRoute({
  method: 'get',
  path: '/pages/seen-users',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'List users who have seen a page',
  request: {
    query: GetSeenUsersRequestSchema,
  },
  responses: {
    200: {
      description: 'Seen-users list (optionally capped by `limit`) and full count',
      content: { 'application/json': { schema: SeenUsersResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const likePageRoute = createRoute({
  method: 'post',
  path: '/pages/like',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Add the current user to the page liker list',
  request: {
    body: {
      content: { 'application/json': { schema: PageIdBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The page with the updated liker list',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const unlikePageRoute = createRoute({
  method: 'post',
  path: '/pages/unlike',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Remove the current user from the page liker list',
  request: {
    body: {
      content: { 'application/json': { schema: PageIdBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The page with the updated liker list',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

// feature-restricted-grant-share-banner Phase 1 — the only endpoint that
// resolves a page by id AND performs grant-on-first-access. Every other
// by-id path (`getPageRoute`'s `page_id` branch, `likePageRoute` /
// `unlikePageRoute` / etc. via `loadGrantedPage`) is unchanged and does
// NOT invite the caller into `grantedUsers` — only `IdRedirector` (the
// share-URL landing component) calls this route. See the spec's
// "アクセス制御の実装" section for why grant-on-access is confined to this
// one endpoint instead of living inside `getPageRoute`.
export const claimPageLinkAccessRoute = createRoute({
  method: 'post',
  path: '/pages/link-access',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Resolve a page by id, granting first-time link-share access to GRANT_RESTRICTED pages',
  request: {
    body: {
      content: { 'application/json': { schema: PageIdBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The resolved page, with `granted` telling whether this call just added the caller to grantedUsers',
      content: { 'application/json': { schema: ClaimPageLinkAccessResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description:
        'The caller has no access to the page (isGrantedFor is false) or lacks scope / is a non-web session — 403 is about the caller lacking access, never about the page grant type per se',
      content: {
        'application/json': {
          schema: z.union([PageNotGrantedErrorSchema, InsufficientScopeErrorSchema]),
        },
      },
    },
    404: {
      description: 'Page not found',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    // Per-user rate limit (30 req/min) — same wire shape as autocomplete's
    // 429 (`{ error: 'rate_limited', message, retryAfterSeconds }`), reused
    // rather than duplicated (see the `AutocompleteRateLimitErrorSchema`
    // import above).
    429: {
      description: 'Rate limit exceeded for POST /pages/link-access (per-user). Same wire shape as autocomplete rate limiting.',
      content: { 'application/json': { schema: AutocompleteRateLimitErrorSchema } },
    },
  },
});

export const getWatchStatusRoute = createRoute({
  method: 'get',
  path: '/pages/watch',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Get watch (notification subscription) status for a page',
  request: {
    query: GetWatchStatusRequestSchema,
  },
  responses: {
    200: {
      description: 'Watching status (true / false)',
      content: { 'application/json': { schema: WatchStatusResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const setWatchStatusRoute = createRoute({
  method: 'put',
  path: '/pages/watch',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Set watch (notification subscription) status for a page',
  request: {
    body: {
      content: { 'application/json': { schema: SetWatchStatusRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated watching status',
      content: { 'application/json': { schema: WatchStatusResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const deletePageRoute = createRoute({
  method: 'delete',
  path: '/pages',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Soft-delete (or hard-delete with completely=true) a page',
  request: {
    // RFC-0021 Phase 2c-2a — required by the SOFT branch only, and enforced in
    // the handler for the same reason as rename: a required header in zod is
    // rejected before the handler runs, and the shared defaultHook's
    // VALIDATION_ERROR does not name the header. Hard delete never reads it.
    headers: z.object({ 'idempotency-key': z.string().optional() }),
    body: {
      content: { 'application/json': { schema: DeletePageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The deleted page (soft-delete: trashed path; hard-delete: original snapshot)',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'PAGE_DELETE_FAILED / IDEMPOTENCY_KEY_REQUIRED / PAGE_TRANSITION_INCOMPLETE',
      content: {
        'application/json': {
          schema: z.union([PageBadRequestErrorSchema, IdempotencyKeyRequiredErrorSchema, PageTransitionIncompleteErrorSchema]),
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    409: {
      description: 'Stale revision_id / IDEMPOTENCY_KEY_CONFLICT / PAGE_TRANSITION_IN_PROGRESS',
      content: {
        'application/json': {
          schema: z.union([PageRevisionErrorSchema, IdempotencyKeyConflictErrorSchema, PageTransitionInProgressErrorSchema]),
        },
      },
    },
  },
});

export const revertDeletedPageRoute = createRoute({
  method: 'post',
  path: '/pages/revert',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Revert a soft-deleted page (restore from /trash/...)',
  request: {
    body: {
      content: { 'application/json': { schema: RevertDeletedPageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The restored page',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'PAGE_REVERT_FAILED',
      content: { 'application/json': { schema: PageBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const revertToRevisionRoute = createRoute({
  method: 'post',
  path: '/pages/revert-to-revision',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Revert a page to one of its past revisions (non-destructive — stacks a new revision)',
  request: {
    body: {
      content: { 'application/json': { schema: RevertToRevisionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The page with the reverted body as its new latest revision',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'PAGE_REVERT_TO_REVISION_FAILED (e.g. the revision does not belong to the page)',
      content: { 'application/json': { schema: PageBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const renamePageRoute = createRoute({
  method: 'post',
  path: '/pages/rename',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Rename (move) a page — optionally together with its subtree',
  request: {
    // RFC-0021 Phase 2c-2a. Declared optional and enforced in the handler on
    // purpose: made required here, zod rejects a missing header before the
    // handler runs and the shared defaultHook answers VALIDATION_ERROR, which
    // tells a client nothing about which header it forgot.
    headers: z.object({ 'idempotency-key': z.string().optional() }),
    body: {
      content: { 'application/json': { schema: RenamePageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The renamed (root) page plus how many pages were moved',
      content: { 'application/json': { schema: RenamePageResponseSchema } },
    },
    400: {
      description: 'PAGE_INVALID_NAME / PAGE_EXISTS / PAGE_RENAME_FAILED / PAGE_RENAME_TREE_FAILED / IDEMPOTENCY_KEY_REQUIRED / PAGE_TRANSITION_INCOMPLETE',
      content: {
        'application/json': {
          schema: z.union([PageBadRequestErrorSchema, RenameTreeErrorSchema, IdempotencyKeyRequiredErrorSchema, PageTransitionIncompleteErrorSchema]),
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    409: {
      description: 'Stale revision_id / IDEMPOTENCY_KEY_CONFLICT / PAGE_TRANSITION_IN_PROGRESS',
      content: {
        'application/json': {
          schema: z.union([PageRevisionErrorSchema, IdempotencyKeyConflictErrorSchema, PageTransitionInProgressErrorSchema]),
        },
      },
    },
  },
});

export const renameSubtreeRoute = createRoute({
  method: 'post',
  path: '/pages/rename-subtree',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Rename (move) a whole subtree by path (for portal-less folders)',
  request: {
    body: {
      content: { 'application/json': { schema: RenameSubtreeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'How many pages were moved',
      content: { 'application/json': { schema: RenameSubtreeResponseSchema } },
    },
    400: {
      description: 'PAGE_INVALID_NAME / PAGE_RENAME_TREE_FAILED (collisions, nothing to move, or partial failure)',
      content: {
        'application/json': {
          schema: z.union([PageBadRequestErrorSchema, RenameTreeErrorSchema]),
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

/**
 * Ordered export for the runtime handler chain and the stub chain in
 * `client.ts`. Order is chosen so literal sub-paths register before
 * any route that could collide on the matcher tree, even though Hono
 * dispatches by `method + path` (paranoid + future-proof).
 *
 * Cross-resource ordering note: revision routes register BEFORE these
 * (in `buildHonoApp`) so the `/pages/*` `createJwtAuth` apply happens
 * once and is shared with page handlers — see the file header.
 */
export const pageRoutes = {
  // GET /pages — getPage (path-or-id query)
  getPageRoute,
  // GET /pages/list — listPages (paginated)
  listPagesRoute,
  // GET /pages/children — listPageChildren (sidebar tree)
  listPageChildrenRoute,
  // POST /pages — createPage
  createPageRoute,
  // PUT /pages — updatePage
  updatePageRoute,
  // PUT /pages/grant — setPageGrant
  setPageGrantRoute,
  // POST /pages/seen — seenPage
  seenPageRoute,
  // GET /pages/seen-users — getSeenUsers
  getSeenUsersRoute,
  // POST /pages/like — likePage
  likePageRoute,
  // POST /pages/unlike — unlikePage
  unlikePageRoute,
  // POST /pages/link-access — claimPageLinkAccess (grant-on-first-access)
  claimPageLinkAccessRoute,
  // GET /pages/watch — getWatchStatus
  getWatchStatusRoute,
  // PUT /pages/watch — setWatchStatus
  setWatchStatusRoute,
  // DELETE /pages — deletePage
  deletePageRoute,
  // POST /pages/revert — revertDeletedPage
  revertDeletedPageRoute,
  // POST /pages/revert-to-revision — revertToRevision
  revertToRevisionRoute,
  // POST /pages/rename — renamePage
  renamePageRoute,
  // POST /pages/rename-subtree — renameSubtree (portal-less folder)
  renameSubtreeRoute,
};
