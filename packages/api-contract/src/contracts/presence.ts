import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { GetLikersRequestSchema, LikersResponseSchema, PresenceTokenResponseSchema } from '../schemas/presence';
import { PageNotFoundErrorSchema } from '../schemas/page';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * RFC-0005 page-presence contract. Phase 1 exposes a single endpoint,
 * `getPresenceToken`, which mints the short-lived JWT a page viewer
 * presents on the `/presence/:pageId` WebSocket handshake.
 *
 * Kept separate from `pageCollabContract` (the Yjs / editor wsToken)
 * because presence is a distinct, lighter channel — page *viewers*
 * connect here without loading Yjs, and the token carries a different
 * issuer claim so the two token kinds can never be cross-replayed.
 *
 * Phase 3 (`GET /api/v2/pages/:id/likers`) adds the "liked by" list
 * endpoint to this same router.
 */
export const presenceContract = c.router({
  /**
   * GET /api/v2/pages/:id/presence-token
   *
   * Auth: authenticated (router-level `jwtAuth`). Issues a 5-minute
   * JWT scoped to `:id` for the caller; the `/presence` WebSocket
   * handler verifies the signature, the `pageId` match, and re-checks
   * read permission before registering the viewer.
   *
   * Authorisation:
   *   - 401 if the caller is unauthenticated.
   *   - 400 if `:id` is not a 24-char hex ObjectId.
   *   - 404 if the page does not exist *or* the caller is not granted
   *     access — the same 404 covers both so page existence is never
   *     leaked to callers without read permission.
   *   - 500 on signing / DB exception.
   */
  getPresenceToken: {
    method: 'GET',
    path: '/pages/:id/presence-token',
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: PresenceTokenResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Issue a short-lived presence token (JWT) for the live-presence WebSocket session',
  },

  /**
   * GET /api/v2/pages/:id/likers (RFC-0005 Phase 3)
   *
   * Returns the users who have liked the page, backing the "Liked by"
   * modal opened from the meta-chip row. Read access to the page is
   * sufficient — the like list is not private.
   *
   * Data source: the page's `liker` ObjectId array (authoritative).
   * Each entry's `likedAt` is a best-effort join with the `ACTION_LIKE`
   * Activity record and may be `null`.
   *
   * Authorisation: same fail-closed pipeline as `getPresenceToken`
   * (401 unauthenticated / 400 malformed id / 404 not-found-or-not-
   * granted / 500 on DB exception).
   */
  getLikers: {
    method: 'GET',
    path: '/pages/:id/likers',
    pathParams: z.object({ id: z.string() }),
    query: GetLikersRequestSchema,
    responses: {
      200: LikersResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'List the users who have liked a page',
  },
});
