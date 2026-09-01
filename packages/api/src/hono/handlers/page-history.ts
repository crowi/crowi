import { getPageHistoryRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import { isTransitionalPageStatus, visiblePageGrantOr } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { type PageHistoryCursor, PageHistoryCorruptionError, PageHistoryCursorError, decodeCursor, readPageHistory } from 'src/service/page-history/read';

import type { CrowiHonoBindings } from '../app';
import { applyScope } from '../middleware/require-scope';

const debug = Debug('crowi:hono:page-history');

/**
 * RFC-0021 Phase 3 — `GET /pages/{pageId}/history`.
 *
 * Authorization runs on a lookup of its own rather than through
 * `findPageByIdAndGrantedUser`: that helper resolves the page's current
 * revision, its author, creator and last editor BEFORE it consults the ACL, so
 * an unauthorized caller still causes those reads. Here the answer is a list of
 * history rows, not the page, so the check only needs the few fields that
 * decide visibility.
 */
export const registerPageHistoryRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');

  // RFC-0010 — reading a page's history is reading the page.
  applyScope(app, getPageHistoryRoute, 'pages:read');

  return app.openapi(getPageHistoryRoute, async (c) => {
    const user = c.get('user') as UserDocument;
    const { pageId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query') as { cursor?: string; limit: number };

    const objectId = new Types.ObjectId(pageId);

    let decoded: PageHistoryCursor | null;
    try {
      // Cursors are minted with the normalised (lowercase) ObjectId string
      // (`encodeCursor`'s `pageId` comes off `objectId.toString()` elsewhere in
      // this read path), so the match has to compare against that same
      // normalised form — not the request's raw param, which the route
      // accepts in either case.
      decoded = cursor == null ? null : decodeCursor(cursor, objectId.toString());
    } catch (err) {
      if (err instanceof PageHistoryCursorError) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: err.message } }, 400);
      }
      throw err;
    }

    // The grant rule is expressed as query clauses, so it is evaluated by the
    // database rather than re-implemented here — one place to be wrong instead
    // of two. Only the few fields the draft rule needs come back.
    let visible: { status?: string | null; creator?: Types.ObjectId } | null;
    try {
      visible = (await Page.findOne({ _id: objectId, $or: visiblePageGrantOr(user._id) })
        .select('status creator')
        .lean()
        .exec()) as typeof visible;
    } catch (err) {
      // Only a definite absence or a definite refusal becomes a 404. Folding an
      // infrastructure failure in there would tell the caller a page that
      // exists does not.
      debug('page-history authorization lookup failed for %s: %s', pageId, (err as Error)?.message);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not read the page history.', pageId } }, 500);
    }

    // A draft is visible only to its author — mirroring the page reads keeps
    // history from leaking that a draft exists.
    const isHiddenDraft = visible != null && visible.status === 'draft' && String(visible.creator ?? '') !== String(user._id);
    if (visible == null || isHiddenDraft || isTransitionalPageStatus(visible.status)) {
      return c.json({ error: { code: 'PAGE_NOT_FOUND' as const, message: 'Page not found' as const } }, 404);
    }

    try {
      const result = await readPageHistory(crowi, { pageId: objectId, limit, cursor: decoded });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof PageHistoryCursorError) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: err.message } }, 400);
      }
      if (err instanceof PageHistoryCorruptionError) {
        // The page identifier is deliberately included: without it an operator
        // cannot run the repair against the right page.
        return c.json({ error: { code: 'INTERNAL_ERROR', message: err.message, pageId: err.pageId } }, 500);
      }
      debug('page-history read failed for %s: %s', pageId, (err as Error)?.message);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not read the page history.', pageId } }, 500);
    }
  });
};
