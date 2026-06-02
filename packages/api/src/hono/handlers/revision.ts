/**
 * RFC-0006 Phase 4 Batch 3 — `revision` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/revision.ts`. Three endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/pages/*`:
 *
 *   GET /pages/:page_id/revisions   — list page revisions (meta only)
 *   GET /pages/revisions            — fetch many revisions by ids
 *   GET /pages/revisions/:id        — fetch a single revision
 *
 * Wire-format parity with the ts-rest era is preserved. Notable points:
 *
 *  - The broad `app.use('/pages/*', ...)` overlaps with the `page`
 *    resource (Batch 4). Hono does **not** dedupe by middleware
 *    reference, so Batch 4's `register*PageRoutes` must NOT re-install
 *    `createJwtAuth(crowi)` on the same prefix — re-installing would
 *    run JWT verify + `User.findById` twice per `/pages/...` request.
 *  - List endpoint populates `author` + `savedBy` + `contributors` in
 *    a single round-trip (chained `.populate()` calls collapse to one
 *    `$lookup` stage).
 *  - `getRevision` performs the on-the-fly meta / renderedAst fallback
 *    for legacy revisions via `computeRevisionRenderArtifactsAsync`.
 *  - `getRevisions` (list-by-ids) rejects mixed-path inputs with 400 so
 *    a single grant check suffices.
 */
import { getRevisionRoute, getRevisionsRoute, listRevisionsRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { RevisionDocument, RevisionMetaContent } from 'src/models/revision';
import { type PopulatedRevision, computeRevisionRenderArtifactsAsync, toRevisionResponse } from 'src/util/page-response';
import { isPopulatedUser, isValidObjectId, toISOStringOrNull, toPageUser } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { PAGE_NOT_FOUND_BODY, invalidRequestBody } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:revision');

const MAX_REVISION_IDS = 10;

/**
 * Delegate to the shared `toRevisionResponse(PopulatedRevision, …)` and
 * widen the return type to `meta` / `renderedAst` mutable, because the
 * detail endpoint overwrites them after `computeRevisionRenderArtifacts`.
 */
type FullRevisionResponse = ReturnType<typeof toRevisionResponse> & {
  meta?: ReturnType<typeof toRevisionResponse>['meta'];
  renderedAst?: unknown;
};

const revisionToFullResponse = (revision: RevisionDocument, options: { withMeta?: boolean; withRenderedAst?: boolean } = {}): FullRevisionResponse =>
  toRevisionResponse(revision.toObject() as PopulatedRevision, options) as FullRevisionResponse;

/**
 * Convert a Revision document to the lightweight meta shape (no body).
 *
 * Phase 8 (RFC-0003): surface `savedBy` + `contributors` for collab-flow
 * checkpoints; v1.x revisions get neither field so pre-RFC-0003 clients
 * keep the old wire shape byte-for-byte.
 */
const revisionToMetaResponse = (revision: RevisionDocument) => {
  const obj = revision.toObject() as {
    author?: unknown;
    savedBy?: unknown;
    contributors?: unknown[];
  };
  const savedBy = isPopulatedUser(obj.savedBy) ? toPageUser(obj.savedBy) : undefined;
  const contributors = Array.isArray(obj.contributors) ? obj.contributors.filter(isPopulatedUser).map(toPageUser) : undefined;
  return {
    _id: revision._id.toString(),
    path: revision.path,
    author: isPopulatedUser(obj.author) ? toPageUser(obj.author) : null,
    savedBy,
    // Omit `.contributors` entirely (not `[]`) when undefined so the
    // pre-RFC-0003 shape stays byte-identical.
    ...(contributors !== undefined ? { contributors } : {}),
    // RFC-0010 — edit channel for the history "app" chip; omitted when
    // absent (pre-RFC-0010 / collab / web) to keep the legacy shape.
    ...(revision.editVia !== undefined ? { editVia: revision.editVia } : {}),
    createdAt: toISOStringOrNull(revision.createdAt) ?? new Date(0).toISOString(),
  };
};

export const registerRevisionRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  // `/pages/*` covers all three routes; the broad apply is idempotent if
  // the page handler (Batch 4) registers it again with the same middleware
  // factory output.
  app.use('/pages/*', createJwtAuth(crowi));
  app.use('/pages', createJwtAuth(crowi));

  // RFC-0010 — revision reads are page reads.
  applyScope(app, listRevisionsRoute, 'pages:read');
  applyScope(app, getRevisionsRoute, 'pages:read');
  applyScope(app, getRevisionRoute, 'pages:read');

  return (
    app
      .openapi(listRevisionsRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('param');
        const { limit, offset } = c.req.valid('query');

        debug('listRevisions called with:', { page_id, limit, offset, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(invalidRequestBody('Invalid page_id'), 400);
        }

        try {
          const page = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!page) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // One round-trip: chained .populate() calls collapse to a
          // single `$lookup` stage. fetch +1 to derive hasNext.
          const allRevisions = await Revision.find({ path: page.path })
            .select('_id path author savedBy contributors editVia createdAt')
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit + 1)
            .populate('author')
            .populate('savedBy')
            .populate('contributors')
            .exec();

          const hasNext = allRevisions.length > limit;
          const sliced = hasNext ? allRevisions.slice(0, limit) : allRevisions;

          return c.json(
            {
              revisions: sliced.map(revisionToMetaResponse),
              pager: {
                prev: offset > 0 ? Math.max(0, offset - limit) : null,
                next: hasNext ? offset + limit : null,
                offset,
              },
            },
            200,
          );
        } catch (err) {
          const error = err as Error;
          debug('Error listing revisions:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          return c.json(invalidRequestBody(error.message || 'Failed to list revisions'), 400);
        }
      })
      // `/pages/revisions` (list-by-ids) MUST register BEFORE
      // `/pages/revisions/{id}` so the literal-path route wins over
      // the `{id}` template — see the contract file header for the
      // ordering rationale.
      .openapi(getRevisionsRoute, async (c) => {
        const user = c.get('user');
        const { ids } = c.req.valid('query');

        debug('getRevisions called with:', { ids, userId: user._id });

        const idList = ids
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        if (idList.length === 0) {
          return c.json(invalidRequestBody('ids is required'), 400);
        }
        if (idList.length > MAX_REVISION_IDS) {
          return c.json(invalidRequestBody(`ids must contain at most ${MAX_REVISION_IDS} entries`), 400);
        }
        if (!idList.every(isValidObjectId)) {
          return c.json(invalidRequestBody('ids contains an invalid revision id'), 400);
        }

        try {
          const objectIds = idList.map((id) => new Types.ObjectId(id));
          const revisions = (await Revision.findRevisions(objectIds)) as RevisionDocument[];

          if (revisions.length === 0) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const paths = new Set(revisions.map((r) => r.path));
          if (paths.size > 1) {
            return c.json(invalidRequestBody('All revisions must share the same path'), 400);
          }

          const sharedPath = revisions[0].path;
          const page = await Page.findOne({ path: sharedPath });
          if (!page || !page.isGrantedFor(user)) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          return c.json({ revisions: revisions.map((r) => revisionToFullResponse(r)) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error fetching revisions:', error.message);
          return c.json(invalidRequestBody(error.message || 'Failed to fetch revisions'), 400);
        }
      })
      .openapi(getRevisionRoute, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');

        debug('getRevision called with:', { id, userId: user._id });

        if (!isValidObjectId(id)) {
          return c.json(invalidRequestBody('Invalid revision id'), 400);
        }

        try {
          const revision = (await Revision.findRevision(new Types.ObjectId(id))) as RevisionDocument | null;
          if (!revision) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // Verify grant via the page that owns this revision's path. Hide
          // existence from non-granted callers (404 not 403).
          const page = await Page.findOne({ path: revision.path });
          if (!page || !page.isGrantedFor(user)) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const response = revisionToFullResponse(revision, { withMeta: false, withRenderedAst: false });
          const obj = revision.toObject() as { meta?: RevisionMetaContent; renderedAst?: unknown; rendererVersion?: string };
          const { meta, renderedAst } = await computeRevisionRenderArtifactsAsync(
            crowi,
            obj.meta,
            obj.renderedAst,
            revision.body,
            obj.rendererVersion,
            page._id?.toString(),
          );
          response.meta = meta;
          response.renderedAst = renderedAst;
          return c.json({ revision: response }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error fetching revision:', error.message);
          return c.json(invalidRequestBody(error.message || 'Failed to fetch revision'), 400);
        }
      })
  );
};
