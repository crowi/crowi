import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, Page, Bookmark } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { UserDocument } from 'src/models/user';
import { PageDocument, visiblePageStatusOr } from 'src/models/page';
import { BookmarkDocument } from 'src/models/bookmark';
import { Types } from 'mongoose';
import { PopulatedUser, isPopulatedUser, toISOStringOrNull, toPageUser, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';
import { type PageLike, pageToResponse } from 'src/util/page-response';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:user');

/**
 * Type for bookmark data that may be a Mongoose document or plain object
 */
interface BookmarkLike {
  _id: Types.ObjectId | string;
  page?: PageLike | null;
  user: PopulatedUser | Types.ObjectId | string;
  createdAt?: Date;
  toObject?: () => BookmarkLike;
}

/**
 * Convert BookmarkDocument to serializable object for API response
 */
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
  const User = crowi.model('User');
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  const userRouter = s.router(apiContract.user, {
    /**
     * GET /api/v2/user/:username
     * Get user page information
     * - Returns user profile with statistics
     * - Includes recent pages (10) and bookmarks (10) for initial display
     */
    getUserPage: async ({ params, req }) => {
      const currentUser = req.user;
      const { username } = params;

      debug('getUserPage called with:', { username, currentUserId: currentUser?._id });

      // Authentication check - this endpoint requires login
      if (!currentUser) {
        return {
          status: 401 as const,
          body: {
            error: {
              code: 'AUTHENTICATION_REQUIRED' as const,
              message: 'Authentication is required' as const,
            },
          },
        };
      }

      try {
        // Find the target user by username
        const targetUser = await User.findUserByUsername(username);

        if (!targetUser) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Check if user is active
        if (targetUser.status !== User.STATUS_ACTIVE) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Get page count for the user — same conditions as findListByCreator.
        const pageCountConditions: any = {
          creator: targetUser._id,
          redirectTo: null,
          $or: visiblePageStatusOr(currentUser._id, targetUser._id),
        };
        // If not viewing own page, only show public pages
        if (!currentUser._id.equals(targetUser._id)) {
          pageCountConditions.grant = Page.GRANT_PUBLIC;
        }
        const createdPagesCount = await Page.countDocuments(pageCountConditions);

        // Get bookmark count for the user
        const bookmarksCount = await Bookmark.countDocuments({ user: targetUser._id });

        // Get recent pages (10 items)
        const recentPagesRaw = await Page.findListByCreator(targetUser, { limit: 10, offset: 0 }, currentUser);
        const recentPages = (await Page.populate(recentPagesRaw, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        // Get recent bookmarks (10 items)
        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit: 10, offset: 0 });
        const recentBookmarks = bookmarkResult.data as BookmarkDocument[];

        return {
          status: 200 as const,
          body: {
            user: toUserPublic(targetUser),
            createdPagesCount,
            bookmarksCount,
            recentPages: recentPages.map((page) => pageToResponse(page)),
            recentBookmarks: recentBookmarks
              .filter((bookmark) => bookmark.page) // Filter out bookmarks with null pages
              .map((bookmark) => bookmarkToResponse(bookmark)),
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching user page:', error.message, error.stack);

        return {
          status: 500 as const,
          body: {
            error: {
              code: 'INTERNAL_ERROR' as const,
              message: 'Internal server error' as const,
            },
          },
        };
      }
    },

    /**
     * GET /api/v2/user/:username/bookmarks
     * Get user bookmarks with pagination
     * - Returns paginated list of bookmarks for a user
     * - Only returns bookmarks for pages the current user can access
     */
    getUserBookmarks: async ({ params, query, req }) => {
      const currentUser = req.user;
      const { username } = params;
      const { limit = 50, offset = 0 } = query;

      debug('getUserBookmarks called with:', { username, limit, offset, currentUserId: currentUser?._id });

      // Authentication check - this endpoint requires login
      if (!currentUser) {
        return {
          status: 401 as const,
          body: {
            error: {
              code: 'AUTHENTICATION_REQUIRED' as const,
              message: 'Authentication is required' as const,
            },
          },
        };
      }

      try {
        // Find the target user by username
        const targetUser = await User.findUserByUsername(username);

        if (!targetUser) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Check if user is active
        if (targetUser.status !== User.STATUS_ACTIVE) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Get bookmarks with pagination
        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit, offset });
        const bookmarks = bookmarkResult.data as BookmarkDocument[];
        const total = bookmarkResult.meta.total;

        // Calculate pagination
        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return {
          status: 200 as const,
          body: {
            bookmarks: bookmarks.filter((bookmark) => bookmark.page).map((bookmark) => bookmarkToResponse(bookmark)),
            pager: {
              prev,
              next,
              offset,
            },
            total,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching user bookmarks:', error.message, error.stack);

        return {
          status: 500 as const,
          body: {
            error: {
              code: 'INTERNAL_ERROR' as const,
              message: 'Internal server error' as const,
            },
          },
        };
      }
    },

    /**
     * GET /api/v2/user/:username/pages
     * Get user created pages with pagination
     * - Returns paginated list of pages created by the user
     * - Only returns pages the current user can access
     */
    getUserPages: async ({ params, query, req }) => {
      const currentUser = req.user;
      const { username } = params;
      const { limit = 50, offset = 0 } = query;

      debug('getUserPages called with:', { username, limit, offset, currentUserId: currentUser?._id });

      // Authentication check - this endpoint requires login
      if (!currentUser) {
        return {
          status: 401 as const,
          body: {
            error: {
              code: 'AUTHENTICATION_REQUIRED' as const,
              message: 'Authentication is required' as const,
            },
          },
        };
      }

      try {
        // Find the target user by username
        const targetUser = await User.findUserByUsername(username);

        if (!targetUser) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Check if user is active
        if (targetUser.status !== User.STATUS_ACTIVE) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'USER_NOT_FOUND' as const,
                message: 'User not found' as const,
              },
            },
          };
        }

        // Get pages created by the user with pagination
        const rawPages = await Page.findListByCreator(targetUser, { limit, offset }, currentUser);
        const pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        // Get total count for pagination — same conditions as findListByCreator.
        const pageCountConditions: any = {
          creator: targetUser._id,
          redirectTo: null,
          $or: visiblePageStatusOr(currentUser._id, targetUser._id),
        };
        // If not viewing own page, only show public pages
        if (!currentUser._id.equals(targetUser._id)) {
          pageCountConditions.grant = Page.GRANT_PUBLIC;
        }
        const total = await Page.countDocuments(pageCountConditions);

        // Calculate pagination
        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return {
          status: 200 as const,
          body: {
            pages: pages.map((page) => pageToResponse(page)),
            pager: {
              prev,
              next,
              offset,
            },
            total,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching user pages:', error.message, error.stack);

        return {
          status: 500 as const,
          body: {
            error: {
              code: 'INTERNAL_ERROR' as const,
              message: 'Internal server error' as const,
            },
          },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.user, userRouter, router);

  return router;
};
