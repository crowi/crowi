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

import { AuthenticationRequiredErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';
import {
  CreatePageRequestSchema,
  GetPageRequestSchema,
  GetPageResponseSchema,
  GetSeenUsersRequestSchema,
  GetWatchStatusRequestSchema,
  ListPageChildrenRequestSchema,
  ListPageChildrenResponseSchema,
  ListPagesRequestSchema,
  ListPagesResponseSchema,
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
  PageRevisionErrorSchema,
  PageSchema,
  RenamePageRequestSchema,
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
      description: 'The requested page with populated revision',
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
      description: 'Page list (newest first) with optional portal page',
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
      description: 'Invalid request (PAGE_EXISTS / NON_EXISTENT_USER_PAGE / PAGE_CREATE_FAILED / INVALID_GRANT)',
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
      description: 'PAGE_DELETE_FAILED',
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
      description: 'Stale revision_id',
      content: { 'application/json': { schema: PageRevisionErrorSchema } },
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

export const renamePageRoute = createRoute({
  method: 'post',
  path: '/pages/rename',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: 'Rename (move) a page to a new path',
  request: {
    body: {
      content: { 'application/json': { schema: RenamePageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The renamed page',
      content: { 'application/json': { schema: PageResponseSchema } },
    },
    400: {
      description: 'PAGE_INVALID_NAME / PAGE_EXISTS / PAGE_RENAME_FAILED',
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
      description: 'Stale revision_id',
      content: { 'application/json': { schema: PageRevisionErrorSchema } },
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
  // GET /pages/watch — getWatchStatus
  getWatchStatusRoute,
  // PUT /pages/watch — setWatchStatus
  setWatchStatusRoute,
  // DELETE /pages — deletePage
  deletePageRoute,
  // POST /pages/revert — revertDeletedPage
  revertDeletedPageRoute,
  // POST /pages/rename — renamePage
  renamePageRoute,
};
