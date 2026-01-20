import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:page');

/**
 * Convert PageDocument to serializable object for API response
 */
const pageToResponse = (page: PageDocument) => {
  const pageObj = page.toObject() as any; // Use any to handle dynamic mongoose document

  // Convert ObjectIds to strings
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
                createdAt: pageObj.revision.author.createdAt.toISOString(),
              }
            : null,
          createdAt: pageObj.revision.createdAt.toISOString(),
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
          createdAt: pageObj.creator.createdAt.toISOString(),
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
          createdAt: pageObj.lastUpdateUser.createdAt.toISOString(),
        }
      : null,
    liker: page.liker?.map((id) => id.toString()) || [],
    seenUsers: page.seenUsers?.map((id) => id.toString()) || [],
    commentCount: page.commentCount || 0,
    extended: page.extended,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt?.toISOString(),
    latestRevision: pageObj.latestRevision?.toString(),
    likerCount: pageObj.likerCount,
    seenUsersCount: pageObj.seenUsersCount,
  };

  return result;
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');

  const pageRouter = s.router(apiContract.page, {
    /**
     * GET /api/v2/pages
     * Get page data by path or page_id
     * - Supports optional revision_id for historical revisions
     * - Requires authentication (loginRequired middleware applied at router level)
     * - Checks page permissions (grant)
     */
    getPage: async ({ query, req }) => {
      const user = (req as any).user as UserDocument;
      const { path, page_id, revision_id } = query;

      debug('getPage called with:', { path, page_id, revision_id, userId: user._id });

      // Validate that at least one of path or page_id is provided
      if (!path && !page_id) {
        return {
          status: 404 as const,
          body: {
            error: {
              code: 'PAGE_NOT_FOUND' as const,
              message: 'Page not found' as const,
            },
          },
        };
      }

      try {
        let page: PageDocument | null = null;

        // Priority: page_id parameter takes precedence over path
        // This matches the original controller logic (lines 651-657)
        if (page_id) {
          debug('Finding page by page_id:', page_id);
          page = await Page.findPageByIdAndGrantedUser(page_id, user);
        } else if (path) {
          debug('Finding page by path:', path);
          page = await Page.findPage(path, user, revision_id || null);
        }

        // Ensure page was found
        if (!page) {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'PAGE_NOT_FOUND' as const,
                message: 'Page not found' as const,
              },
            },
          };
        }

        // Check if page has redirect
        if (page.redirectTo) {
          debug('Page has redirect to:', page.redirectTo);
          // For now, return the page with redirectTo field
          // Client can handle the redirect
          // TODO: Consider if we should follow the redirect automatically
        }

        // Convert page document to API response format
        const pageResponse = pageToResponse(page);

        return {
          status: 200 as const,
          body: {
            page: pageResponse,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error fetching page:', error.message);

        // Handle specific error types
        if (error.message === 'Page not found' || error.name === 'Crowi:Page:NotFound') {
          return {
            status: 404 as const,
            body: {
              error: {
                code: 'PAGE_NOT_FOUND' as const,
                message: 'Page not found' as const,
              },
            },
          };
        }

        if (error.message === 'Page is not granted for the user') {
          return {
            status: 403 as const,
            body: {
              error: {
                code: 'PAGE_NOT_GRANTED' as const,
                message: 'Page is not granted for the user' as const,
              },
            },
          };
        }

        // Generic error fallback
        debug('Unexpected error:', error);
        return {
          status: 404 as const,
          body: {
            error: {
              code: 'PAGE_NOT_FOUND' as const,
              message: 'Page not found' as const,
            },
          },
        };
      }
    },

    /**
     * GET /api/v2/pages/list
     * List pages by path or user
     * - Supports pagination with limit and offset
     * - Returns pages with populated creator and lastUpdateUser
     */
    listPages: async ({ query, req }) => {
      const user = (req as any).user as UserDocument;
      const { path, user: userParam, limit = 50, offset = 0 } = query;

      debug('listPages called with:', { path, user: userParam, limit, offset, userId: user._id });

      try {
        let pages: PageDocument[] = [];
        let portalPage: PageDocument | null = null;

        if (userParam) {
          // List pages by creator
          debug('Finding pages by creator:', userParam);
          const targetUser = await crowi.model('User').findById(userParam);
          if (!targetUser) {
            return {
              status: 200 as const,
              body: {
                pages: [],
                pager: {
                  prev: null,
                  next: null,
                  offset: 0,
                },
                portalPage: null,
              },
            };
          }

          pages = await Page.findListByCreator(targetUser, { limit, offset }, user);
        } else if (path && path !== '/') {
          // List pages by path and get portal page
          debug('Finding pages by path:', path);
          debug('Query params:', { limit, offset, path, userParam });
          [portalPage, pages] = await Promise.all([Page.findPortalPage(path, user), Page.findListByStartWith(path, user, { limit, offset })]);
          debug('Found pages:', pages.length);
          debug('Found portal page:', !!portalPage);
        } else {
          // List all pages the user can access (including path='/')
          debug('Finding all accessible pages', { path });
          const conditions: any = {
            redirectTo: null,
            $or: [{ status: null }, { status: 'published' }],
            grant: { $in: [1, 2] }, // PUBLIC or RESTRICTED
          };

          // If path='/', also get portal page
          if (path === '/') {
            [portalPage, pages] = await Promise.all([
              Page.findPortalPage(path, user),
              Page.find(conditions)
                .sort({ updatedAt: -1 })
                .skip(offset)
                .limit(limit)
                .populate({ path: 'revision', populate: { path: 'author' } })
                .populate('creator')
                .populate('lastUpdateUser')
                .exec(),
            ]);
          } else {
            pages = await Page.find(conditions)
              .sort({ updatedAt: -1 })
              .skip(offset)
              .limit(limit)
              .populate({ path: 'revision', populate: { path: 'author' } })
              .populate('creator')
              .populate('lastUpdateUser')
              .exec();
          }
        }

        // Convert pages to response format
        const pageResponses = pages.map((page) => pageToResponse(page));
        const portalPageResponse = portalPage ? pageToResponse(portalPage) : null;

        // Calculate pagination
        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = pages.length === limit ? offset + limit : null;

        return {
          status: 200 as const,
          body: {
            pages: pageResponses,
            pager: {
              prev,
              next,
              offset,
            },
            portalPage: portalPageResponse,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing pages:', error.message);

        // Return empty list on error
        return {
          status: 200 as const,
          body: {
            pages: [],
            pager: {
              prev: null,
              next: null,
              offset: 0,
            },
            portalPage: null,
          },
        };
      }
    },
    createPage: async () => {
      throw new Error('Not implemented');
    },
    updatePage: async () => {
      throw new Error('Not implemented');
    },
    seenPage: async () => {
      throw new Error('Not implemented');
    },
    likePage: async () => {
      throw new Error('Not implemented');
    },
    unlikePage: async () => {
      throw new Error('Not implemented');
    },
    deletePage: async () => {
      throw new Error('Not implemented');
    },
    revertDeletedPage: async () => {
      throw new Error('Not implemented');
    },
    renamePage: async () => {
      throw new Error('Not implemented');
    },
  });

  createExpressEndpoints(apiContract.page, pageRouter, router);

  return router;
};
