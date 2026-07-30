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
import type { UserDocument } from 'src/models/user';
import { computeRevisionRenderArtifactsAsync, type PopulatedRevision, toRevisionResponse } from 'src/util/page-response';
import { pickRenderedAstShape, varyOnAstVersion } from 'src/util/rendered-ast-negotiation';
import { actorFromUser, isPopulatedUser, isValidObjectId, resolveGrantedRevisionOwner, toISOStringOrNull, toPageUser } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { invalidRequestBody, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:revision');

const MAX_REVISION_IDS = 10;

/**
 * Delegate to the shared `toRevisionResponse(PopulatedRevision, …)` and
 * widen the return type to `meta` / `renderedAst` mutable, because the
 * detail endpoint overwrites them after `computeRevisionRenderArtifacts`.
 */
type FullRevisionResponse = ReturnType<typeof toRevisionResponse> & {
  meta?: ReturnType<typeof toRevisionResponse>['meta'];
  renderedAst?: ReturnType<typeof toRevisionResponse>['renderedAst'];
  renderedAstArtifactKey?: string;
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

  // DC-5 grant boundary — shared implementation in `ts-rest-helpers.ts`
  // (also used by comment.ts's by-revision listing); this thin bind only
  // fixes the Page model argument.
  const resolveOwner = (pageId: Types.ObjectId | null | undefined, user: UserDocument) => resolveGrantedRevisionOwner(Page, pageId, user);

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
          // DC-5: query by the immutable `page` id (already resolved above
          // via the grant check) rather than the mutable `path` string.
          const allRevisions = await Revision.find({ page: page._id })
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

          // DC-5: converge on the shared `page` id rather than the mutable
          // `path` string — a revision with no `page` (pre-migration /
          // orphan, see `revision-page-ref-backfill`) still needs the same
          // "all requested revisions belong to one page" invariant, so it
          // simply never matches another revision's id (or itself, below).
          const pageIds = new Set(revisions.map((r) => r.page?.toString()));
          if (pageIds.size > 1) {
            return c.json(invalidRequestBody('All revisions must share the same page'), 400);
          }

          // Orphaned revision(s) with no page ref fail closed (404) here
          // too — not a regression: the path-based lookup this replaces
          // could previously resolve to *whichever unrelated page
          // currently occupies that path* (path is reused over time),
          // which was itself a latent grant bug — see the spec's finding.
          const page = await resolveOwner(revisions[0].page, user);
          if (!page) {
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

          // Verify grant via the page that owns this revision (DC-5: the
          // immutable `revision.page` id, not a `path` reverse-lookup — a
          // rename or a delete-then-recreate-at-the-same-path could
          // otherwise resolve to an unrelated page's grant). Hide existence
          // from non-granted callers (404 not 403); an orphaned revision
          // (pre-migration / standard-path deviation, see
          // `revision-page-ref-backfill`) fails closed the same way.
          const page = await resolveOwner(revision.page, user);
          if (!page) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const response = revisionToFullResponse(revision, { withMeta: false, withRenderedAst: false });
          const obj = revision.toObject() as { meta?: RevisionMetaContent; renderedAst?: unknown; rendererVersion?: string };
          const { meta, renderedAst, renderedAstArtifactKey } = await computeRevisionRenderArtifactsAsync(
            crowi,
            obj.meta,
            obj.renderedAst,
            revision.body,
            actorFromUser(user),
            obj.rendererVersion,
            page._id?.toString(),
          );
          response.meta = meta;
          // RFC-0023 §9 — envelope for `X-Crowi-Ast-Version: 1`
          // declarants, verbatim bare Root for everyone else.
          response.renderedAst = pickRenderedAstShape(c.get('astVersion'), renderedAst) as FullRevisionResponse['renderedAst'];
          response.renderedAstArtifactKey = renderedAstArtifactKey;
          varyOnAstVersion(c);
          return c.json({ revision: response }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error fetching revision:', error.message);
          return c.json(invalidRequestBody(error.message || 'Failed to fetch revision'), 400);
        }
      })
  );
};
