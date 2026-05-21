/**
 * RFC-0006 Phase 4 Batch 5 — `pageCollab` resource ported to
 * `@hono/zod-openapi` route definitions. Single endpoint:
 *
 *   GET /pages/:id/yjs-token — Hocuspocus connection wsToken (RFC-0003)
 *
 * Auth: JWT required. The page handler chain shares `createJwtAuth(crowi)`
 * via the broad `/pages/*` apply installed by the `revision` handler
 * (see `packages/api/src/hono/handlers/revision.ts`). Hono does NOT
 * dedupe middleware by reference, so the pageCollab handler does NOT
 * install jwtAuth itself — the runtime contract is "register
 * `registerRevisionRoutes` before `registerPageCollabRoutes` in
 * `buildHonoApp`" (same rationale as `page` / `page-preview`).
 *
 * Route-order considerations:
 *
 *  - `/pages/:id/yjs-token` shares the `/pages/{page_id}/...` prefix
 *    with revision's `/pages/{page_id}/revisions` (24-hex regex gates
 *    the param). Hono dispatches by `method + full path` so the literal
 *    `/yjs-token` suffix wins; there is no matcher ambiguity.
 *  - The literal page sub-paths (`/pages/list`, `/pages/grant`, etc.)
 *    use a fixed segment in position 2 of the URL whereas
 *    `/yjs-token` uses a hex id, so no collision is possible.
 *
 * Standalone contract (separate from `pageContract`) because the
 * WebSocket-handshake surface is its own discoverable bundle (the Phase
 * 6 cleanup that deletes Crowi 1.x's legacy page contract should leave
 * collab routing untouched).
 */
import { createRoute, z } from '@hono/zod-openapi';

import { WsTokenResponseSchema } from '../schemas/collab';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';
import { PageNotFoundErrorSchema } from '../schemas/page';

const PageIdPathParamsSchema = z.object({
  id: z.string().openapi({ description: 'Page id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

/**
 * GET /api/v2/pages/:id/yjs-token (RFC-0003 Phase 2)
 *
 * Mints the short-lived JWT (`wsToken`) the Hocuspocus client
 * (`HocuspocusProvider`) presents on connect. Phase 3 wires
 * `onAuthenticate` to the matching verify helper so a leaked token is
 * reduced to a 5-minute exposure window scoped to a single page id.
 *
 * Authorisation:
 *   - 401 if the caller is unauthenticated (router-level `jwtAuth`).
 *   - 400 if `:id` is not a 24-char hex ObjectId.
 *   - 404 if the page does not exist *or* the caller is not granted
 *     access. The same 404 covers both cases by design (matches
 *     `loadGrantedPage` behaviour) so we never leak page existence to
 *     callers without grant. Draft pages (RFC-0004) collapse "draft
 *     owned by someone else" into the same 404.
 *   - 500 on signing / DB exception.
 *
 * The `readonly` flag in the response will become `true` once the
 * 20-user editor cap is exhausted (Phase 6 Redis counter); pre-cap
 * deployments always observe `readonly: false`.
 */
export const getYjsTokenRoute = createRoute({
  method: 'get',
  path: '/pages/{id}/yjs-token',
  tags: ['page-collab'],
  security: [{ bearerAuth: [] }],
  summary: 'Issue a short-lived wsToken (JWT) for the Hocuspocus realtime session',
  request: {
    params: PageIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Signed wsToken (JWT) + scope metadata',
      content: { 'application/json': { schema: WsTokenResponseSchema } },
    },
    400: {
      description: 'Invalid page id',
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
    500: {
      description: 'wsToken signing or DB exception',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const pageCollabRoutes = {
  getYjsTokenRoute,
};
