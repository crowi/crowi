/**
 * RFC-0006 Phase 4 Batch 3 — `backlink` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/backlink.ts`. Single endpoint:
 *
 *   GET /backlinks — list backlinks targeting a page
 *
 * Behind `createJwtAuth(crowi)` applied broadly to `/backlinks/*`.
 * Wire-format parity is preserved: the response trims to `limit` after
 * filtering out dangling / hidden-draft / ungranted rows, and `hasNext`
 * is derived from an over-fetch of `limit + 1` records. Both the target
 * `page_id` and each `fromPage` are grant-checked (SEC-BACKLINK-LEAK):
 * the target page must be granted to the caller (404 otherwise, mirroring
 * the existence-hiding convention of other page-scoped endpoints) and a
 * `fromPage` without grant for the caller is dropped from the list, same
 * as RFC-0004 hidden-draft pages.
 */
import { type Backlink as BacklinkResponse, getBacklinksRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import { type PageDocument, STATUS_DRAFT } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { isPopulatedUser, isValidObjectId, loadGrantedPage, toISOStringOrNull, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:backlink');

interface RawBacklink {
  _id: Types.ObjectId | string;
  page?: Types.ObjectId | string;
  fromPage: PageDocument | Types.ObjectId | string | null;
  fromRevision: { _id: Types.ObjectId | string; author?: unknown } | Types.ObjectId | string | null;
  updatedAt: Date;
}

const isPopulatedFromPage = (value: unknown): value is PageDocument => {
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

const toBacklinkResponse = (raw: RawBacklink, pageId: string, user: UserDocument): BacklinkResponse | null => {
  const { fromPage, fromRevision } = raw;
  const viewerId = user._id.toString();
  if (!isPopulatedFromPage(fromPage) || typeof fromPage.path !== 'string') return null;
  if (isHiddenDraftFromPage(fromPage, viewerId)) return null;
  // SEC-BACKLINK-LEAK: a fromPage without grant for the caller must not
  // leak its existence / path through another page's backlink view.
  if (!fromPage.isGrantedFor(user)) return null;
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
  const Page = crowi.model('Page');

  app.use('/backlinks/*', createJwtAuth(crowi));
  app.use('/backlinks', createJwtAuth(crowi));

  // RFC-0010 — backlinks are a page-graph read.
  applyScope(app, getBacklinksRoute, 'pages:read');

  return app.openapi(getBacklinksRoute, async (c) => {
    const user = c.get('user');
    const { page_id, limit, offset } = c.req.valid('query');

    debug('getBacklinks called with:', { page_id, limit, offset, viewerId: user._id.toString() });

    // Zod's regex already enforces 24-hex, but guard defensively for
    // call paths that bypass the contract validator (e.g. direct
    // handler invocation in unit tests).
    if (!isValidObjectId(page_id)) {
      return c.json(INVALID_PAGE_ID_BODY, 400);
    }

    // SEC-BACKLINK-LEAK: the target page must be granted to the caller,
    // or the endpoint would leak the existence / path of private pages
    // via their backlink graph. 404 collapses not-found and not-granted
    // (existence-hiding convention shared with the other page-scoped
    // endpoints, e.g. presence.ts / page-collab.ts).
    const loaded = await loadGrantedPage(Page, page_id, user);
    if ('error' in loaded) {
      return c.json(PAGE_NOT_FOUND_BODY, 404);
    }

    const fetchLimit = limit + 1;
    const rawBacklinks = (await Backlink.findByPageId(loaded.page._id, fetchLimit, offset)) as unknown as RawBacklink[];

    const resolved = rawBacklinks.map((raw) => toBacklinkResponse(raw, page_id, user)).filter((b): b is BacklinkResponse => b !== null);

    const hasNext = resolved.length > limit;
    const backlinks = hasNext ? resolved.slice(0, limit) : resolved;

    return c.json({ backlinks, hasNext }, 200);
  });
};
