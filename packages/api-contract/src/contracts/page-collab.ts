import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { WsTokenResponseSchema } from '../schemas/collab';
import { PageNotFoundErrorSchema } from '../schemas/page';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * Standalone collaboration contract (RFC-0003, Phase 2). Currently
 * exposes a single endpoint, `getYjsToken`, which issues the short-lived
 * JWT (`wsToken`) that the Hocuspocus client (`HocuspocusProvider`)
 * presents on connect. Future phases (force-reload broadcast / save UI
 * helpers) will land additional endpoints under this router as needed.
 *
 * Kept separate from `pageContract` (CRUD) and `pagePreviewContract`
 * (renderer) so the WebSocket-handshake surface is discoverable as one
 * bundle and so the `Crowi 1.x → 2.x` migration can drop the legacy
 * page contract without touching collab routing.
 */
export const pageCollabContract = c.router({
  /**
   * GET /api/v2/pages/:id/yjs-token
   *
   * Auth: authenticated. Issues a 5-minute JWT scoped to `:id` for the
   * caller. The token carries `{ userId, pageId, readonly }`; Phase 3
   * Hocuspocus `onAuthenticate` verifies the signature with the same
   * `WS_TOKEN_SECRET` and refuses cross-page or expired tokens.
   *
   * Authorisation:
   *   - 401 if the caller is unauthenticated (router-level `jwtAuth`).
   *   - 400 if `:id` is not a 24-char hex ObjectId.
   *   - 404 if the page does not exist *or* the caller is not granted
   *     access. The same 404 covers both cases by design (matches
   *     `loadGrantedPage` behaviour) so we never leak page existence to
   *     callers without grant.
   *   - 500 on signing / DB exception.
   *
   * The `readonly` flag in the response will become `true` once the
   * 20-user editor cap is exhausted (Phase 6 Redis counter); in Phase 2
   * it is always `false` per the cap stub.
   */
  getYjsToken: {
    method: 'GET',
    path: '/pages/:id/yjs-token',
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: WsTokenResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Issue a short-lived wsToken (JWT) for the Hocuspocus realtime session',
  },
});
