import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import { BookmarkDocument } from 'src/models/bookmark';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:user');

/**
 * Helper to safely convert date to ISO string
 */
const toISOStringOrNull = (date: Date | undefined | null): string | null => {
  if (!date) return null;
  return date instanceof Date ? date.toISOString() : String(date);
};

/**
 * Convert UserDocument to serializable object for API response
 */
const userToResponse = (user: UserDocument) => {
  return {
    _id: user._id.toString(),
    id: user._id.toString(),
    username: user.username,
    name: user.name,
    email: user.email,
    image: user.image || null,
    introduction: user.introduction || '',
    createdAt: toISOStringOrNull(user.createdAt) || new Date().toISOString(),
    admin: user.admin || false,
    status: user.status,
  };
};

/**
 * Convert PageDocument to serializable object for API response
 */
const pageToResponse = (page: PageDocument) => {
  const pageObj = page.toObject() as any;

  const result: any = {
    _id: page._id.toString(),
    path: page.path,
    revision: pageObj.revision
      ? {
          _id: pageObj.revision._id.toString(),
          path: pageObj.revision.path,
          body: pageObj.revision.body,
          format: pageObj.revision.format || 'markdown',
          author: pageObj.revision.author
            ? {
                _id: pageObj.revision.author._id.toString(),
                id: pageObj.revision.author._id.toString(),
                username: pageObj.revision.author.username,
                name: pageObj.revision.author.name,
                email: pageObj.revision.author.email,
                image: pageObj.revision.author.image || null,
                createdAt: toISOStringOrNull(pageObj.revision.author.createdAt),
              }
            : null,
          createdAt: toISOStringOrNull(pageObj.revision.createdAt),
        }
      : undefined,
    redirectTo: page.redirectTo || null,
    status: page.status || null,
    grant: page.grant,
    grantedUsers: page.grantedUsers?.map((id) => id.toString()) || [],
    creator: pageObj.creator
      ? {
          _id: pageObj.creator._id.toString(),
          id: pageObj.creator._id.toString(),
          username: pageObj.creator.username,
          name: pageObj.creator.name,
          email: pageObj.creator.email,
          image: pageObj.creator.image || null,
          createdAt: toISOStringOrNull(pageObj.creator.createdAt),
        }
      : null,
    lastUpdateUser: pageObj.lastUpdateUser
      ? {
          _id: pageObj.lastUpdateUser._id.toString(),
          id: pageObj.lastUpdateUser._id.toString(),
          username: pageObj.lastUpdateUser.username,
          name: pageObj.lastUpdateUser.name,
          email: pageObj.lastUpdateUser.email,
          image: pageObj.lastUpdateUser.image || null,
          createdAt: toISOStringOrNull(pageObj.lastUpdateUser.createdAt),
        }
      : null,
    liker: page.liker?.map((id) => id.toString()) || [],
    seenUsers: page.seenUsers?.map((id) => id.toString()) || [],
    commentCount: page.commentCount || 0,
    extended: page.extended,
    createdAt: toISOStringOrNull(page.createdAt),
    updatedAt: toISOStringOrNull(page.updatedAt),
    latestRevision: pageObj.latestRevision?.toString(),
    likerCount: pageObj.likerCount,
    seenUsersCount: pageObj.seenUsersCount,
  };

  return result;
};

/**
 * Convert BookmarkDocument to serializable object for API response
 */
const bookmarkToResponse = (bookmark: BookmarkDocument) => {
  const bookmarkObj = bookmark.toObject ? bookmark.toObject() : (bookmark as any);

  return {
    _id: bookmarkObj._id.toString(),
    page: bookmarkObj.page ? pageToResponse(bookmarkObj.page) : null,
    user:
      typeof bookmarkObj.user === 'object'
        ? {
            _id: bookmarkObj.user._id.toString(),
            id: bookmarkObj.user._id.toString(),
            username: bookmarkObj.user.username,
            name: bookmarkObj.user.name,
            email: bookmarkObj.user.email,
            image: bookmarkObj.user.image || null,
            createdAt: toISOStringOrNull(bookmarkObj.user.createdAt),
          }
        : bookmarkObj.user.toString(),
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
      const currentUser = (req as any).user as UserDocument | null;
      const { username } = params;

      debug('getUserPage called with:', { username, currentUserId: currentUser?._id });

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

        // Get page count for the user
        // Use the same conditions as findListByCreator
        const pageCountConditions: any = {
          creator: targetUser._id,
          redirectTo: null,
          $or: [{ status: null }, { status: 'published' }],
        };
        // If not viewing own page and not logged in, only show public pages
        if (!currentUser || !currentUser._id.equals(targetUser._id)) {
          pageCountConditions.grant = Page.GRANT_PUBLIC;
        }
        const createdPagesCount = await Page.countDocuments(pageCountConditions);

        // Get bookmark count for the user
        const bookmarksCount = await Bookmark.countDocuments({ user: targetUser._id });

        // Get recent pages (10 items)
        const recentPagesRaw = await Page.findListByCreator(targetUser, { limit: 10, offset: 0 }, currentUser || targetUser);
        const recentPages = (await Page.populate(recentPagesRaw, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        // Get recent bookmarks (10 items)
        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit: 10, offset: 0 });
        const recentBookmarks = bookmarkResult.data as BookmarkDocument[];

        return {
          status: 200 as const,
          body: {
            user: userToResponse(targetUser),
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
        debug('Error fetching user page:', error.message);

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
    },

    /**
     * GET /api/v2/user/:username/bookmarks
     * Get user bookmarks with pagination
     * - Returns paginated list of bookmarks for a user
     * - Only returns bookmarks for pages the current user can access
     */
    getUserBookmarks: async ({ params, query, req }) => {
      const currentUser = (req as any).user as UserDocument | undefined;
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
        debug('Error fetching user bookmarks:', error.message);

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
    },

    /**
     * GET /api/v2/user/:username/pages
     * Get user created pages with pagination
     * - Returns paginated list of pages created by the user
     * - Only returns pages the current user can access
     */
    getUserPages: async ({ params, query, req }) => {
      const currentUser = (req as any).user as UserDocument | undefined;
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

        // Get total count for pagination
        const pageCountConditions: any = {
          creator: targetUser._id,
          redirectTo: null,
          $or: [{ status: null }, { status: 'published' }],
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
        debug('Error fetching user pages:', error.message);

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
    },
  });

  createExpressEndpoints(apiContract.user, userRouter, router);

  return router;
};
