import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { internalServerErrorResponse, loadGrantedPage } from 'src/util/ts-rest-helpers';
import { checkEditorCap } from 'src/util/collab-cap';
import { createWsTokenUtil } from 'src/util/ws-token';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:page-collab');

/**
 * GET /api/v2/pages/:id/yjs-token (RFC-0003 Phase 2)
 *
 * Mints the short-lived JWT (`wsToken`) the Hocuspocus client carries
 * on the WebSocket handshake. Phase 3 wires `onAuthenticate` to the
 * matching verify helper so a leaked wsToken is reduced to a 5-minute
 * exposure window scoped to a single page id.
 *
 * Authorisation pipeline (all gates fail-closed):
 *   1. `jwtAuth` — already applied at the router level, so we just
 *      narrow `req.user` to `UserDocument`.
 *   2. `loadGrantedPage` — validates the 24-char hex page id and
 *      ensures the caller has grant. Crowi v1.x has no read-only grant
 *      tier, so being able to read the page is equivalent to being
 *      able to edit it; downstream Hocuspocus only needs to re-check
 *      grant on `onAuthenticate` for token-replay safety (Phase 3).
 *   3. `checkEditorCap` — Phase 6 will INCR a Redis counter here and
 *      flip `readonly` to true at the 20-user cap. The stub always
 *      returns `{ readonly: false }`.
 *
 * Note on `403 vs 404`: the spec section header says "403 if no edit
 * permission", but every other page-scoped ts-rest endpoint collapses
 * "not found" and "not granted" into a 404 so page existence is not
 * leaked. We do the same here. See the openQuestion in the task plan.
 */
export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  // Resolve / sign helper once per server (closure-captures the secret).
  const wsTokenUtil = createWsTokenUtil();

  const collabRouter = s.router(apiContract.pageCollab, {
    getYjsToken: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id: pageId } = params;
      const Page = crowi.model('Page');

      debug('getYjsToken called', { pageId, userId: user._id.toString() });

      const loaded = await loadGrantedPage(Page, pageId, user);
      if ('error' in loaded) return loaded.error;

      try {
        const { readonly } = await checkEditorCap(crowi, pageId);
        const { token, expiresAt } = wsTokenUtil.signWsToken({
          userId: user._id.toString(),
          pageId,
          readonly,
        });

        return {
          status: 200 as const,
          body: {
            wsToken: token,
            pageId,
            expiresAt: expiresAt.toISOString(),
            readonly,
          },
        };
      } catch (err) {
        debug('wsToken signing failed:', (err as Error).message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.pageCollab, collabRouter, router);

  return router;
};
