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
import { populatePageRelationData } from 'src/util/page-response';
import { isPopulatedUser, isValidObjectId, toISOStringOrNull, toPageUser, toStringId } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { type BookmarkLike, bookmarkToResponse, bookmarksToResponseList } from './_helpers/bookmark-response';
import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:bookmark');

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
        if (!bookmark) {
          return c.json({ bookmark: null }, 200);
        }

        // D-2 — `Bookmark.findByPageIdAndUserId` never populates `page`, so
        // this route has its own response schema (`GetBookmarkResponseSchema`)
        // with `page` as a bare id string; it does not go through
        // `bookmarkToResponse` (which requires an `EnrichedPage`).
        const obj = bookmark.toObject();
        return c.json(
          {
            bookmark: {
              _id: toStringId(obj._id),
              page: obj.page ? toStringId(obj.page as Types.ObjectId) : null,
              user: isPopulatedUser(obj.user) ? toPageUser(obj.user) : toStringId(obj.user as Types.ObjectId | string),
              createdAt: toISOStringOrNull(obj.createdAt) || new Date().toISOString(),
            },
          },
          200,
        );
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
        const bookmarks = (result.data as BookmarkDocument[]).filter((bookmark) => bookmark.page);
        const total: number = result.meta.total;

        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        // D-2 — one batched enrichment call for every populated Page in
        // this response, then match each bookmark to its page by id (never
        // by array position — see the spec's D-2 note on why a zip is
        // unsafe here).
        return c.json(
          {
            bookmarks: await bookmarksToResponseList(crowi, bookmarks, user),
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

        // D-2 — singleton enrichment (fixed 3-query batch of size 1); the
        // enriched Page is passed straight to `bookmarkToResponse`'s second
        // argument rather than assigned onto `bookmarkObj.page` (which
        // would only be lost again on the next `toObject()`).
        const [enrichedPage] = await populatePageRelationData(crowi, [pageData], user);
        return c.json({ bookmark: bookmarkToResponse(bookmarkObj, enrichedPage) }, 200);
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
