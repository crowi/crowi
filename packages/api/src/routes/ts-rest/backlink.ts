import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type Backlink as BacklinkResponse } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { invalidPageIdResponse, isValidObjectId, isPopulatedUser, toUserPublic, toISOStringOrNull, toStringId } from 'src/util/ts-rest-helpers';
import { STATUS_DRAFT } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:backlink');

interface RawBacklink {
  _id: Types.ObjectId | string;
  // `page` is intentionally NOT included in Backlink.findByPageId's
  // projection, so the field can be undefined here. The handler echoes the
  // request's page_id back into the response body instead.
  page?: Types.ObjectId | string;
  // `findByPageId` populates `fromPage` without a field selection, so
  // `status` / `creator` ride along — used below to drop other users'
  // draft pages from the response (RFC-0004).
  fromPage: { _id: Types.ObjectId | string; path?: string; status?: string; creator?: Types.ObjectId | string } | Types.ObjectId | string | null;
  fromRevision: { _id: Types.ObjectId | string; author?: unknown } | Types.ObjectId | string | null;
  updatedAt: Date;
}

const isPopulatedFromPage = (value: unknown): value is { _id: Types.ObjectId | string; path?: string; status?: string; creator?: Types.ObjectId | string } => {
  return !!value && typeof value === 'object' && '_id' in value && 'path' in value;
};

/**
 * RFC-0004: a draft `fromPage` is visible only to its author. Drop a
 * backlink whose source page is another user's draft so a draft can
 * never leak its existence / path through the backlink list.
 */
const isHiddenDraftFromPage = (fromPage: { status?: string; creator?: Types.ObjectId | string }, viewerId: string): boolean => {
  if (fromPage.status !== STATUS_DRAFT) return false;
  return fromPage.creator?.toString() !== viewerId;
};

const isPopulatedFromRevision = (value: unknown): value is { _id: Types.ObjectId | string; author?: unknown } => {
  return !!value && typeof value === 'object' && '_id' in value;
};

// Drop entries whose populated `fromPage` or `fromRevision` reference dangling
// docs (deleted pages / revisions). These would otherwise produce malformed
// payloads that fail Zod validation at the contract boundary.
//
// `pageId` is the request page_id; we echo it into the response because the
// underlying find() projection does not include the `page` field.
const toBacklinkResponse = (raw: RawBacklink, pageId: string, viewerId: string): BacklinkResponse | null => {
  const { fromPage, fromRevision } = raw;
  if (!isPopulatedFromPage(fromPage) || typeof fromPage.path !== 'string') return null;
  if (isHiddenDraftFromPage(fromPage, viewerId)) return null;
  if (!isPopulatedFromRevision(fromRevision)) return null;

  return {
    _id: toStringId(raw._id),
    page: pageId,
    fromPage: {
      _id: toStringId(fromPage._id),
      path: fromPage.path,
    },
    fromRevision: {
      _id: toStringId(fromRevision._id),
      author: isPopulatedUser(fromRevision.author) ? toUserPublic(fromRevision.author) : null,
    },
    updatedAt: toISOStringOrNull(raw.updatedAt) ?? new Date(0).toISOString(),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Backlink = crowi.model('Backlink');

  const backlinkRouter = s.router(apiContract.backlink, {
    /**
     * GET /api/v2/backlinks
     * List backlinks targeting the page.
     *
     * Implementation notes:
     * - Fetch limit+1 records to derive `hasNext` without a second count query
     *   (cheaper than countDocuments for large indexes and matches the legacy
     *   React UI's pagination semantics).
     * - findByPageId returns documents (not lean objects) and accepts string
     *   numerics for limit/offset. Zod has already coerced and bounds-checked
     *   them; we pass them through as numbers.
     * - We do NOT apply grant filtering on `fromPage`. Mirrors legacy
     *   /_api/backlink.list behavior; see openQuestions in the task plan for
     *   the security trade-off.
     */
    getBacklinks: async ({ query, req }) => {
      const { page_id, limit, offset } = query;
      const viewerId = (req.user as UserDocument)._id.toString();

      debug('getBacklinks called with:', { page_id, limit, offset });

      // Defense-in-depth: Zod already enforces 24-hex via the contract. This
      // catches the unlikely case where validation is bypassed (e.g. test
      // harness that mounts the handler directly).
      if (!isValidObjectId(page_id)) {
        return invalidPageIdResponse;
      }

      const pageObjectId = new Types.ObjectId(page_id);
      const fetchLimit = limit + 1;
      const rawBacklinks = (await Backlink.findByPageId(pageObjectId, fetchLimit, offset)) as unknown as RawBacklink[];

      // Resolve (map + drop hidden-draft / non-populated rows) before
      // trimming, so a filtered-out row never eats into the requested
      // page size — `hasNext` and the slice both run on visible rows.
      const resolved = rawBacklinks.map((raw) => toBacklinkResponse(raw, page_id, viewerId)).filter((b): b is BacklinkResponse => b !== null);

      const hasNext = resolved.length > limit;
      const backlinks = hasNext ? resolved.slice(0, limit) : resolved;

      return {
        status: 200 as const,
        body: { backlinks, hasNext },
      };
    },
  });

  createExpressEndpoints(apiContract.backlink, backlinkRouter, router);

  return router;
};
