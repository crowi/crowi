import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { PresenceTokenResponseSchema } from '../schemas/presence';
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
});
