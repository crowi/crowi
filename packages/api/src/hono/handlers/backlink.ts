/**
 * RFC-0006 Phase 4 Batch 3 — `backlink` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/backlink.ts`. Single endpoint:
 *
 *   GET /backlinks — list backlinks targeting a page
 *
 * Behind `createJwtAuth(crowi)` applied broadly to `/backlinks/*`.
 * Wire-format parity is preserved: the response trims to `limit` after
 * filtering out dangling / hidden-draft rows, and `hasNext` is derived
 * from an over-fetch of `limit + 1` records. The grant policy on
 * `fromPage` mirrors the legacy `/_api/backlink.list` semantics (no
 * grant filter) but RFC-0004 hidden-draft pages are dropped from
 * another user's view.
 */
import { type Backlink as BacklinkResponse, getBacklinksRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import { STATUS_DRAFT } from 'src/models/page';
import { isPopulatedUser, isValidObjectId, toISOStringOrNull, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { INVALID_PAGE_ID_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:backlink');

interface RawBacklink {
  _id: Types.ObjectId | string;
  page?: Types.ObjectId | string;
  fromPage: { _id: Types.ObjectId | string; path?: string; status?: string; creator?: Types.ObjectId | string } | Types.ObjectId | string | null;
  fromRevision: { _id: Types.ObjectId | string; author?: unknown } | Types.ObjectId | string | null;
  updatedAt: Date;
}

const isPopulatedFromPage = (value: unknown): value is { _id: Types.ObjectId | string; path?: string; status?: string; creator?: Types.ObjectId | string } => {
  return !!value && typeof value === 'object' && '_id' in value && 'path' in value;
};

/**
 * RFC-0004: a draft `fromPage` is visible only to its author. Drop the
 * backlink so a draft can never leak its existence / path through
 * another user's backlink view.
 */
const isHiddenDraftFromPage = (fromPage: { status?: string; creator?: Types.ObjectId | string }, viewerId: string): boolean => {
  if (fromPage.status !== STATUS_DRAFT) return false;
  return fromPage.creator?.toString() !== viewerId;
};

const isPopulatedFromRevision = (value: unknown): value is { _id: Types.ObjectId | string; author?: unknown } => {
  return !!value && typeof value === 'object' && '_id' in value;
};

const toBacklinkResponse = (raw: RawBacklink, pageId: string, viewerId: string): BacklinkResponse | null => {
  const { fromPage, fromRevision } = raw;
  if (!isPopulatedFromPage(fromPage) || typeof fromPage.path !== 'string') return null;
  if (isHiddenDraftFromPage(fromPage, viewerId)) return null;
  if (!isPopulatedFromRevision(fromRevision)) return null;

  return {
    _id: toStringId(raw._id),
    page: pageId,
    fromPage: { _id: toStringId(fromPage._id), path: fromPage.path },
    fromRevision: {
      _id: toStringId(fromRevision._id),
      author: isPopulatedUser(fromRevision.author) ? toUserPublic(fromRevision.author) : null,
    },
    updatedAt: toISOStringOrNull(raw.updatedAt) ?? new Date(0).toISOString(),
  };
};

export const registerBacklinkRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Backlink = crowi.model('Backlink');

  app.use('/backlinks/*', createJwtAuth(crowi));
  app.use('/backlinks', createJwtAuth(crowi));

  // RFC-0010 — backlinks are a page-graph read.
  applyScope(app, getBacklinksRoute, 'pages:read');

  return app.openapi(getBacklinksRoute, async (c) => {
    const user = c.get('user');
    const { page_id, limit, offset } = c.req.valid('query');
    const viewerId = user._id.toString();

    debug('getBacklinks called with:', { page_id, limit, offset, viewerId });

    // Zod's regex already enforces 24-hex, but guard defensively for
    // call paths that bypass the contract validator (e.g. direct
    // handler invocation in unit tests).
    if (!isValidObjectId(page_id)) {
      return c.json(INVALID_PAGE_ID_BODY, 400);
    }

    const pageObjectId = new Types.ObjectId(page_id);
    const fetchLimit = limit + 1;
    const rawBacklinks = (await Backlink.findByPageId(pageObjectId, fetchLimit, offset)) as unknown as RawBacklink[];

    const resolved = rawBacklinks.map((raw) => toBacklinkResponse(raw, page_id, viewerId)).filter((b): b is BacklinkResponse => b !== null);

    const hasNext = resolved.length > limit;
    const backlinks = hasNext ? resolved.slice(0, limit) : resolved;

    return c.json({ backlinks, hasNext }, 200);
  });
};
