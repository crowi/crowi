import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { internalServerErrorResponse, loadGrantedPage } from 'src/util/ts-rest-helpers';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:presence');

/**
 * GET /api/v2/pages/:id/presence-token (RFC-0005 Phase 1)
 *
 * Mints the short-lived JWT a page *viewer* carries on the
 * `/presence/:pageId` WebSocket handshake. The presence handler
 * verifies this token (signature + pageId match) and re-checks read
 * permission before registering the viewer in the Redis viewer hash.
 *
 * Parallels `page-collab.ts:getYjsToken` (the collab wsToken endpoint)
 * but issues a token signed by a *separate* issuer (`crowi-presence`)
 * so a leaked presence token can never be replayed against the
 * write-capable `/collab` channel.
 *
 * Authorisation pipeline (all gates fail-closed):
 *   1. `jwtAuth` — applied at the router level; we just narrow
 *      `req.user` to `UserDocument`.
 *   2. `loadGrantedPage` — validates the 24-char hex page id and
 *      ensures the caller has read grant. "Not found" and "not
 *      granted" collapse to the same 404 so page existence is never
 *      leaked (matches every other page-scoped ts-rest endpoint).
 *
 * Note: presence is read-only viewer tracking, so — unlike the collab
 * wsToken route — there is no draft-author gate here. A user who can
 * read a draft page (its author) can also appear in its presence row;
 * a non-author already gets the 404 from `loadGrantedPage`.
 */
export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  // Resolve / sign helper once per server (closure-captures the secret).
  const presenceTokenUtil = createPresenceTokenUtil();

  const presenceRouter = s.router(apiContract.presence, {
    getPresenceToken: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id: pageId } = params;
      const Page = crowi.model('Page');

      debug('getPresenceToken called', { pageId, userId: user._id.toString() });

      const loaded = await loadGrantedPage(Page, pageId, user);
      if ('error' in loaded) return loaded.error;

      try {
        const userId = user._id.toString();
        const { token, expiresAt } = presenceTokenUtil.signPresenceToken({ userId, pageId });

        return {
          status: 200 as const,
          body: {
            token,
            pageId,
            selfUserId: userId,
            expiresAt: expiresAt.toISOString(),
          },
        };
      } catch (err) {
        debug('presence token signing failed:', (err as Error).message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.presence, presenceRouter, router);

  return router;
};
