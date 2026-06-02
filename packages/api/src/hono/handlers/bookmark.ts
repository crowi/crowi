/**
 * RFC-0006 Phase 4 Batch 3 — `bookmark` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/bookmark.ts`. Four endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/bookmarks/*`:
 *
 *   GET    /bookmarks       — fetch bookmark for a page (or null)
 *   GET    /bookmarks/me    — paginated current-user bookmarks
 *   POST   /bookmarks       — add a bookmark
 *   DELETE /bookmarks       — remove a bookmark
 *
 * Wire-format parity with the ts-rest era is preserved. The handlers
 * keep the legacy quirks:
 *
 *  - `addBookmark` returns `{ bookmark: null }` instead of 404 when the
 *    page is missing or not granted — this matches the legacy
 *    `/_api/bookmarks.add` controller and prevents the UI from
 *    showing an error on a race where the page disappears between
 *    page-view and the bookmark click.
 *  - `removeBookmark` returns `{ ok: true }` even when there was no
 *    bookmark to delete (legacy `/_api/bookmarks.remove` did the same).
 */
import { addBookmarkRoute, getBookmarkRoute, listMyBookmarksRoute, removeBookmarkRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { BookmarkDocument } from 'src/models/bookmark';
import type { PageDocument } from 'src/models/page';
import { type PageLike, pageToResponse } from 'src/util/page-response';
import { type PopulatedUser, isPopulatedUser, isValidObjectId, toISOStringOrNull, toPageUser, toStringId } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:bookmark');

interface BookmarkLike {
  _id: Types.ObjectId | string;
  page?: PageLike | null;
  user: PopulatedUser | Types.ObjectId | string;
  createdAt?: Date;
  toObject?: () => BookmarkLike;
}

/**
 * Serialize a Bookmark document into the wire shape. Mirrors the ts-rest
 * handler so the JSON payload is byte-identical: page populated via
 * `pageToResponse`, user lifted to `PageUser` when populated otherwise
 * left as a string id, createdAt always emitted as ISO string.
 */
const bookmarkToResponse = (bookmark: BookmarkDocument | BookmarkLike) => {
  const obj: BookmarkLike =
    typeof (bookmark as BookmarkDocument).toObject === 'function' ? (bookmark as BookmarkDocument).toObject() : (bookmark as BookmarkLike);
  return {
    _id: toStringId(obj._id),
    page: obj.page ? pageToResponse(obj.page) : null,
    user: isPopulatedUser(obj.user) ? toPageUser(obj.user) : toStringId(obj.user as Types.ObjectId | string),
    createdAt: toISOStringOrNull(obj.createdAt) || new Date().toISOString(),
  };
};

export const registerBookmarkRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  // Every `/bookmarks/*` endpoint requires auth. Apply broadly so each
  // route below sees `c.get('user')` populated. The path matcher
  // intentionally covers `/bookmarks` (the bare path) too because Hono
  // treats `/bookmarks/*` as matching the trailing slash variants.
  app.use('/bookmarks/*', createJwtAuth(crowi));
  app.use('/bookmarks', createJwtAuth(crowi));

  // RFC-0010 — bookmark add/remove are bookmarks:write.
  applyScope(app, getBookmarkRoute, 'bookmarks:read');
  applyScope(app, listMyBookmarksRoute, 'bookmarks:read');
  applyScope(app, addBookmarkRoute, 'bookmarks:write');
  applyScope(app, removeBookmarkRoute, 'bookmarks:write');

  return app
    .openapi(getBookmarkRoute, async (c) => {
      const user = c.get('user');
      const { page_id } = c.req.valid('query');

      debug('getBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return c.json(INVALID_PAGE_ID_BODY, 400);
      }

      try {
        const pageObjectId = new Types.ObjectId(page_id);
        const bookmark = (await Bookmark.findByPageIdAndUserId(pageObjectId, user._id)) as BookmarkDocument | null;

        return c.json({ bookmark: bookmark ? bookmarkToResponse(bookmark) : null }, 200);
      } catch (err) {
        debug('Error fetching bookmark:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(listMyBookmarksRoute, async (c) => {
      const user = c.get('user');
      const { limit, offset } = c.req.valid('query');

      debug('listMyBookmarks called with:', { limit, offset, userId: user._id });

      try {
        const result = await Bookmark.findByUserId(user._id, { limit, offset });
        const bookmarks = result.data as BookmarkDocument[];
        const total: number = result.meta.total;

        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return c.json(
          {
            bookmarks: bookmarks.filter((bookmark) => bookmark.page).map((bookmark) => bookmarkToResponse(bookmark)),
            pager: { prev, next, offset },
            total,
          },
          200,
        );
      } catch (err) {
        debug('Error listing my bookmarks:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(addBookmarkRoute, async (c) => {
      const user = c.get('user');
      const { page_id } = c.req.valid('json');

      debug('addBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return c.json(INVALID_PAGE_ID_BODY, 400);
      }

      let pageData: PageDocument | null = null;
      try {
        pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
      } catch (err) {
        const error = err as Error;
        // findPageByIdAndGrantedUser throws on not-found / not-granted.
        // Collapse both into `{ bookmark: null }` so the legacy
        // /_api/bookmarks.add semantics are preserved: the UI never
        // surfaces a 404 here even when the page disappears between
        // page-view and the bookmark click.
        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return c.json({ bookmark: null }, 200);
        }
        debug('Error fetching page for bookmark:', error.message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      if (!pageData) {
        return c.json({ bookmark: null }, 200);
      }

      try {
        const created = (await Bookmark.add(pageData, user)) as BookmarkDocument;

        // Depopulate then re-attach the page we already loaded so the response
        // matches the populated shape without re-running `populate('page')`.
        created.depopulate('page');
        created.depopulate('user');
        const bookmarkObj = created.toObject() as BookmarkLike;
        bookmarkObj.page = pageData as unknown as PageLike;

        return c.json({ bookmark: bookmarkToResponse(bookmarkObj) }, 200);
      } catch (err) {
        debug('Error adding bookmark:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(removeBookmarkRoute, async (c) => {
      const user = c.get('user');
      const { page_id } = c.req.valid('json');

      debug('removeBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return c.json(INVALID_PAGE_ID_BODY, 400);
      }

      try {
        await Bookmark.removeBookmark(new Types.ObjectId(page_id), user);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        debug('Error removing bookmark:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
