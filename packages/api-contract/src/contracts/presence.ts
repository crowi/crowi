/**
 * RFC-0006 Phase 4 Batch 5 — `presence` resource ported to
 * `@hono/zod-openapi` route definitions. Two endpoints:
 *
 *   GET /pages/:id/presence-token — RFC-0005 viewer presence wsToken
 *   GET /pages/:id/likers         — RFC-0005 Phase 3 liker list
 *
 * Auth: JWT required. Like `pageCollab` / `page` / `page-preview`, this
 * handler does NOT install `createJwtAuth(crowi)` itself — the
 * `revision` handler's broad apply on `/pages/*` is reused (Hono does
 * not dedupe middleware by reference; re-installing would cost a second
 * JWT verify + `User.findById` per request). Register order in
 * `buildHonoApp` is `revision -> page -> page-preview -> pageCollab ->
 * presence -> notification`.
 *
 * Distinct from `pageCollabContract` because presence is a separate,
 * lighter WebSocket channel: page *viewers* connect to `/presence`
 * without ever loading Yjs, and the presence token is signed by a
 * distinct issuer (`crowi-presence`) so a leaked wsToken can never be
 * replayed against the presence channel and vice versa.
 *
 * Route-order considerations:
 *
 *  - `/pages/:id/presence-token` + `/pages/:id/likers` share the
 *    `/pages/{page_id}/...` prefix with revision's
 *    `/pages/{page_id}/revisions` (24-hex regex gates the param) and
 *    pageCollab's `/pages/:id/yjs-token`. Hono dispatches by
 *    `method + full path` so the literal suffix wins; no matcher
 *    ambiguity. The literal page sub-paths (`/pages/list` etc.) use
 *    a fixed segment in position 2 vs. our hex id, so no collision.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';
import { PageNotFoundErrorSchema } from '../schemas/page';
import { GetLikersRequestSchema, LikersResponseSchema, PresenceTokenResponseSchema } from '../schemas/presence';

const PageIdPathParamsSchema = z.object({
  id: z.string().openapi({ description: 'Page id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

/**
 * GET /api/v2/pages/:id/presence-token (RFC-0005 Phase 1)
 *
 * Mints the short-lived JWT a page viewer presents on the
 * `/presence/:pageId` WebSocket handshake. The presence handler
 * verifies this token (signature + pageId match) and re-checks read
 * permission before registering the viewer in the Redis viewer hash.
 *
 * Authorisation:
 *   - 401 if the caller is unauthenticated.
 *   - 400 if `:id` is not a 24-char hex ObjectId.
 *   - 404 if the page does not exist *or* the caller is not granted
 *     access — same 404 covers both so page existence is never leaked.
 *   - 500 on signing / DB exception.
 *
 * Unlike the collab wsToken route, there is no draft-author gate here:
 * presence is read-only viewer tracking, so any user with read access
 * can appear in the viewer list. A non-author already gets the 404
 * from `loadGrantedPage`.
 */
export const getPresenceTokenRoute = createRoute({
  method: 'get',
  path: '/pages/{id}/presence-token',
  tags: ['presence'],
  security: [{ bearerAuth: [] }],
  summary: 'Issue a short-lived presence token (JWT) for the live-presence WebSocket session',
  request: {
    params: PageIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Signed presence token + scope metadata',
      content: { 'application/json': { schema: PresenceTokenResponseSchema } },
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
      description: 'Token signing or DB exception',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

/**
 * GET /api/v2/pages/:id/likers (RFC-0005 Phase 3)
 *
 * Returns the users who have liked the page, backing the "Liked by"
 * modal opened from the meta-chip row. Read access to the page is
 * sufficient — the like list is not private.
 *
 * Data source: the page's `liker` ObjectId array (authoritative). Each
 * entry's `likedAt` is a best-effort join with the `ACTION_LIKE`
 * Activity record and may be `null`.
 *
 * Authorisation: same fail-closed pipeline as `getPresenceToken`.
 */
export const getLikersRoute = createRoute({
  method: 'get',
  path: '/pages/{id}/likers',
  tags: ['presence'],
  security: [{ bearerAuth: [] }],
  summary: 'List the users who have liked a page',
  request: {
    params: PageIdPathParamsSchema,
    query: GetLikersRequestSchema,
  },
  responses: {
    200: {
      description: 'Liker list (newest-liked first when known) with full totalCount',
      content: { 'application/json': { schema: LikersResponseSchema } },
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
      description: 'DB exception',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const presenceRoutes = {
  getPresenceTokenRoute,
  getLikersRoute,
};
