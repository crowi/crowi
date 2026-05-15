import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { computeRevisionRenderArtifactsAsync, resolveRevisionMeta } from 'src/util/page-response';
import type { RevisionMetaContent } from 'src/models/revision';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import { RevisionDocument } from 'src/models/revision';
import { isPopulatedUser, isValidObjectId, pageNotFoundResponse, toISOStringOrNull, toPageUser } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:revision');

const MAX_REVISION_IDS = 10;

const invalidRequest = (message: string) =>
  ({
    status: 400 as const,
    body: { error: { code: 'INVALID_REQUEST' as const, message } },
  }) as const;

/**
 * Convert a revision document (with optionally populated author) to the
 * full RevisionSchema shape (body included). Sync path — for legacy
 * revisions missing `meta` / `renderedAst`, callers compose with
 * `computeRevisionMetaAsync` / `computeRevisionRenderedAstAsync` on the
 * side to attach the on-the-fly fallback.
 */
const revisionToFullResponse = (revision: RevisionDocument, options: { withMeta?: boolean; withRenderedAst?: boolean } = {}) => {
  const obj = revision.toObject() as RevisionDocument & {
    author: Parameters<typeof toPageUser>[0] | null | undefined;
    meta?: RevisionMetaContent;
    renderedAst?: unknown;
  };
  return {
    _id: revision._id.toString(),
    path: revision.path,
    body: revision.body,
    format: revision.format || 'markdown',
    author: isPopulatedUser(obj.author) ? toPageUser(obj.author) : null,
    createdAt: toISOStringOrNull(revision.createdAt) ?? new Date(0).toISOString(),
    meta: resolveRevisionMeta(obj.meta, options.withMeta),
    renderedAst: options.withRenderedAst ? obj.renderedAst : undefined,
  };
};

/**
 * Convert to the lightweight RevisionMetaSchema shape (no body, no format).
 *
 * Phase 8 (RFC-0003) addition: when the underlying Revision has the
 * collab-flow `savedBy` / `contributors` populated (i.e. it was
 * created by a `crowi:save` checkpoint), surface both in the meta
 * response so the page-history view can render
 *   "Saved by Alice (with Bob, Carol)"
 *
 * v1.x revisions (and any Revision predating RFC-0003) are left with
 * `savedBy: undefined` / `contributors: undefined` so the consumer
 * falls back to the existing `author`-only display — no schema break.
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
    // Omit the field entirely (not `[]`) when undefined so v1.x
    // responses match the pre-RFC-0003 shape byte-for-byte; the
    // optional `.contributors` on `RevisionMetaSchema` covers both
    // shapes.
    ...(contributors !== undefined ? { contributors } : {}),
    createdAt: toISOStringOrNull(revision.createdAt) ?? new Date(0).toISOString(),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  const revisionRouter = s.router(apiContract.revision, {
    /**
     * GET /api/v2/pages/:page_id/revisions
     * List the revisions of a page (meta only, newest first).
     * - Grant is verified via Page.findPageByIdAndGrantedUser; not-granted
     *   surfaces as 404 to avoid leaking page existence.
     */
    listRevisions: async ({ params, query, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = params;
      const { limit, offset } = query;

      debug('listRevisions called with:', { page_id, limit, offset, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return invalidRequest('Invalid page_id');
      }

      try {
        const page = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!page) {
          return pageNotFoundResponse;
        }

        // findRevisionIdList returns _id, author, createdAt only and sorts desc.
        // We populate author for response shaping; path is filled from the page
        // because findRevisionIdList omits it (it's redundant for a single page).
        //
        // Phase 8 (RFC-0003): also pull savedBy + contributors so the
        // history view can render checkpoint authors + the awareness-
        // confirmed peer list. Populating in one round-trip (chained
        // `.populate()` calls collapse to a single `$lookup`) keeps the
        // list endpoint at O(1) DB queries irrespective of contributor
        // count.
        const allRevisions = await Revision.find({ path: page.path })
          .select('_id path author savedBy contributors createdAt')
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit + 1) // fetch +1 to know if there's a next page
          .populate('author')
          .populate('savedBy')
          .populate('contributors')
          .exec();

        const hasNext = allRevisions.length > limit;
        const sliced = hasNext ? allRevisions.slice(0, limit) : allRevisions;

        return {
          status: 200 as const,
          body: {
            revisions: sliced.map(revisionToMetaResponse),
            pager: {
              prev: offset > 0 ? Math.max(0, offset - limit) : null,
              next: hasNext ? offset + limit : null,
              offset,
            },
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing revisions:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return pageNotFoundResponse;
        }

        return invalidRequest(error.message || 'Failed to list revisions');
      }
    },

    /**
     * GET /api/v2/pages/revisions/:id
     * Fetch a single revision (with body) by id.
     * - Verifies grant via the revision's path: legacy /_api/revisions.get
     *   skipped this check, which we strengthen here.
     */
    getRevision: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id } = params;

      debug('getRevision called with:', { id, userId: user._id });

      if (!isValidObjectId(id)) {
        return invalidRequest('Invalid revision id');
      }

      try {
        const revision = (await Revision.findRevision(new Types.ObjectId(id))) as RevisionDocument | null;
        if (!revision) {
          return pageNotFoundResponse;
        }

        // Verify grant via the page that owns this revision's path. Hide
        // existence from non-granted callers (404 not 403).
        const page = await Page.findOne({ path: revision.path });
        if (!page) {
          return pageNotFoundResponse;
        }
        if (!page.isGrantedFor(user)) {
          return pageNotFoundResponse;
        }

        const response = revisionToFullResponse(revision, { withMeta: false, withRenderedAst: false });
        // On-the-fly fallback for legacy revisions: one pipeline run
        // produces both meta + renderedAst, so use the combined helper
        // to avoid running parse+transform+shiki twice.
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
        return {
          status: 200 as const,
          body: { revision: response },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching revision:', error.message);
        return invalidRequest(error.message || 'Failed to fetch revision');
      }
    },

    /**
     * GET /api/v2/pages/revisions?ids=a,b,...
     * Fetch multiple revisions in one call (intended for diff-viewer pairs).
     * - All requested revisions must share the same path so that a single
     *   grant check is sufficient. Mixed paths are rejected as 400 to
     *   simplify authorization semantics.
     */
    getRevisions: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { ids } = query;

      debug('getRevisions called with:', { ids, userId: user._id });

      const idList = ids
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (idList.length === 0) {
        return invalidRequest('ids is required');
      }
      if (idList.length > MAX_REVISION_IDS) {
        return invalidRequest(`ids must contain at most ${MAX_REVISION_IDS} entries`);
      }
      if (!idList.every(isValidObjectId)) {
        return invalidRequest('ids contains an invalid revision id');
      }

      try {
        const objectIds = idList.map((id) => new Types.ObjectId(id));
        const revisions = (await Revision.findRevisions(objectIds)) as RevisionDocument[];

        if (revisions.length === 0) {
          return pageNotFoundResponse;
        }

        // All revisions must share the same path (mixed paths are rejected).
        const paths = new Set(revisions.map((r) => r.path));
        if (paths.size > 1) {
          return invalidRequest('All revisions must share the same path');
        }

        const sharedPath = revisions[0].path;
        const page = await Page.findOne({ path: sharedPath });
        if (!page) {
          return pageNotFoundResponse;
        }
        if (!page.isGrantedFor(user)) {
          return pageNotFoundResponse;
        }

        return {
          status: 200 as const,
          body: { revisions: revisions.map((r) => revisionToFullResponse(r)) },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching revisions:', error.message);
        return invalidRequest(error.message || 'Failed to fetch revisions');
      }
    },
  });

  createExpressEndpoints(apiContract.revision, revisionRouter, router);

  return router;
};
