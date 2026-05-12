import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { internalServerErrorResponse } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:page-preview');

/**
 * POST /api/v2/pages/preview
 *
 * Render arbitrary markdown to mdast for the editor preview pane. The
 * pipeline is shared with the save path so editor preview and page
 * show produce byte-identical trees for the same input — preview is
 * the single source of truth for "what will this body look like when
 * saved" instead of duplicating the renderer on the client.
 *
 * Why a separate handler (not a flag on existing `getPage` / `getRevision`):
 * - The input is raw text that has not been (and may never be)
 *   persisted, so the contract has no `page_id` to plumb in.
 * - It does not touch any model — no revision is created, no `seen`
 *   bookkeeping fires, no plugin-dispatch cache is consulted (we run
 *   the pipeline without a `pageId` so embed-tag / url-inline-expand
 *   degrade to plain text, same as orphan-revision fallback).
 *
 * Auth: this handler is mounted under `authenticatedRouter`, so
 * `jwtAuth` already gated the request before we get here. We do not
 * need an additional admin / grant check because the renderer is pure
 * and never reads from the page graph.
 */
export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const previewRouter = s.router(apiContract.pagePreview, {
    previewPage: async ({ body: requestBody }) => {
      try {
        // `mode: 'view'` mirrors what `computeRevisionRenderArtifactsAsync`
        // uses for read-path on-the-fly fallback; the registered
        // transforms decide whether to short-circuit based on it.
        // No `pageId` is supplied — plugin-dispatch transforms degrade
        // to plain text in that case, which is the right behaviour for
        // a preview that may belong to no persisted page yet.
        // `getRenderer()` throws if setup hasn't run; the catch maps
        // it to 500 alongside any pipeline failure.
        const { renderedAst } = await crowi.getRenderer().runRender(requestBody.body, { mode: 'view' });
        return {
          status: 200 as const,
          body: { renderedAst },
        };
      } catch (err) {
        debug('preview pipeline failed:', (err as Error).message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.pagePreview, previewRouter, router);

  return router;
};
