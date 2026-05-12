import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, Bookmark, Page } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import { BookmarkDocument } from 'src/models/bookmark';
import { PopulatedUser, invalidPageIdResponse, isPopulatedUser, isValidObjectId, toISOStringOrNull, toPageUser, toStringId } from 'src/util/ts-rest-helpers';
import { type PageLike, pageToResponse } from 'src/util/page-response';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:bookmark');

interface BookmarkLike {
  _id: Types.ObjectId | string;
  page?: PageLike | null;
  user: PopulatedUser | Types.ObjectId | string;
  createdAt?: Date;
  toObject?: () => BookmarkLike;
}

const bookmarkToResponse = (bookmark: BookmarkDocument | BookmarkLike): Bookmark => {
  const bookmarkObj: BookmarkLike =
    typeof (bookmark as BookmarkDocument).toObject === 'function' ? (bookmark as BookmarkDocument).toObject() : (bookmark as BookmarkLike);

  return {
    _id: toStringId(bookmarkObj._id),
    page: bookmarkObj.page ? pageToResponse(bookmarkObj.page) : (null as unknown as Page),
    user: isPopulatedUser(bookmarkObj.user) ? toPageUser(bookmarkObj.user) : toStringId(bookmarkObj.user as Types.ObjectId | string),
    createdAt: toISOStringOrNull(bookmarkObj.createdAt) || new Date().toISOString(),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  const bookmarkRouter = s.router(apiContract.bookmark, {
    /**
     * GET /api/v2/bookmarks?page_id=xxx
     * Returns the current user's bookmark for a given page (or null).
     * Equivalent to legacy GET /_api/bookmarks.get.
     */
    getBookmark: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = query;

      debug('getBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return invalidPageIdResponse;
      }

      try {
        const pageObjectId = new Types.ObjectId(page_id);
        const bookmark = (await Bookmark.findByPageIdAndUserId(pageObjectId, user._id)) as BookmarkDocument | null;

        return {
          status: 200 as const,
          body: {
            bookmark: bookmark ? bookmarkToResponse(bookmark) : null,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching bookmark:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * GET /api/v2/bookmarks/me?limit&offset
     * Paginated list of the current user's bookmarks.
     * Equivalent to legacy GET /_api/bookmarks.list (paginate).
     */
    listMyBookmarks: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { limit = 50, offset = 0 } = query;

      debug('listMyBookmarks called with:', { limit, offset, userId: user._id });

      try {
        // Bookmark.findByUserId always populates the page (and its revision/author).
        const result = await Bookmark.findByUserId(user._id, { limit, offset });
        const bookmarks = result.data as BookmarkDocument[];
        const total: number = result.meta.total;

        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return {
          status: 200 as const,
          body: {
            bookmarks: bookmarks
              .filter((bookmark) => bookmark.page) // populatePage may filter out inaccessible pages
              .map((bookmark) => bookmarkToResponse(bookmark)),
            pager: { prev, next, offset },
            total,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing my bookmarks:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * POST /api/v2/bookmarks { page_id }
     * Add a bookmark for the current user.
     * If the page is not accessible / does not exist, returns { bookmark: null }
     * to preserve legacy /_api/bookmarks.add behavior.
     */
    addBookmark: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('addBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return invalidPageIdResponse;
      }

      let pageData: PageDocument | null = null;
      try {
        pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
      } catch (err) {
        const error = err as Error;
        // findPageByIdAndGrantedUser throws on not-found / not-granted.
        // Per the planner spec we collapse both cases into { bookmark: null }
        // so that the new endpoint behaves like the legacy `else` branch
        // (which the legacy controller also intended even though it was
        // unreachable in practice).
        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return { status: 200 as const, body: { bookmark: null } };
        }
        debug('Error fetching page for bookmark:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }

      if (!pageData) {
        return { status: 200 as const, body: { bookmark: null } };
      }

      try {
        const created = (await Bookmark.add(pageData, user)) as BookmarkDocument;

        // Mirror the legacy controller: depopulate before serializing so we
        // do not leak full populated docs that the response schema may not expect.
        // We then re-populate via pageToResponse using the page document we already fetched.
        created.depopulate('page');
        created.depopulate('user');

        // Build a hybrid object: the bookmark with the page populated by pageData.
        const bookmarkObj = created.toObject() as BookmarkLike;
        bookmarkObj.page = pageData as unknown as PageLike;

        return {
          status: 200 as const,
          body: {
            bookmark: bookmarkToResponse(bookmarkObj),
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error adding bookmark:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * DELETE /api/v2/bookmarks { page_id }
     * Remove a bookmark for the current user.
     * Mirrors the legacy controller: deletes by (page, user) directly.
     * Returns { ok: true } even when there was no bookmark to delete
     * (the legacy controller emits ApiResponse.success() unconditionally).
     */
    removeBookmark: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('removeBookmark called with:', { page_id, userId: user._id });

      if (!isValidObjectId(page_id)) {
        return invalidPageIdResponse;
      }

      try {
        await Bookmark.removeBookmark(new Types.ObjectId(page_id), user);
        return { status: 200 as const, body: { ok: true as const } };
      } catch (err) {
        const error = err as Error;
        debug('Error removing bookmark:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.bookmark, bookmarkRouter, router);

  return router;
};
