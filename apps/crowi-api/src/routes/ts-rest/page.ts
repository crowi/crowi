import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, PageGrantEnum, UserPublic } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import {
  invalidPageIdResponse,
  isPopulatedUser,
  isValidObjectId,
  loadGrantedPage,
  pageNotFoundResponse,
  toISOStringOrNull,
  toPageUser,
  toUserPublic,
} from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:page');

const VALID_GRANTS: number[] = Object.values(PageGrantEnum);

const invalidGrantResponse = () =>
  ({
    status: 400 as const,
    body: {
      error: {
        code: 'INVALID_GRANT',
        message: 'grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)',
      },
    },
  }) as const;

const pageToResponse = (page: PageDocument) => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pageObj = page.toObject() as any;

  // The shape we produce satisfies both PageSchema and PageWithRevisionSchema
  // depending on whether `revision` is populated. ts-rest contracts pin one
  // or the other, so this helper returns `any` and each handler narrows at
  // its return site.
  const result: any = {
    _id: page._id.toString(),
    path: page.path,
    revision: pageObj.revision
      ? {
          _id: pageObj.revision._id.toString(),
          path: pageObj.revision.path,
          body: pageObj.revision.body,
          format: pageObj.revision.format || 'markdown',
          author: isPopulatedUser(pageObj.revision.author) ? toPageUser(pageObj.revision.author) : null,
          // Schema requires createdAt as a string; legacy / no-timestamps
          // documents may yield null at runtime — fall back to epoch.
          createdAt: toISOStringOrNull(pageObj.revision.createdAt) ?? new Date(0).toISOString(),
        }
      : undefined,
    redirectTo: page.redirectTo || null,
    status: page.status || null,
    grant: page.grant,
    grantedUsers: page.grantedUsers?.map((id) => id.toString()) || [],
    creator: isPopulatedUser(pageObj.creator) ? toPageUser(pageObj.creator) : null,
    lastUpdateUser: isPopulatedUser(pageObj.lastUpdateUser) ? toPageUser(pageObj.lastUpdateUser) : null,
    liker: page.liker?.map((id) => id.toString()) || [],
    seenUsers: page.seenUsers?.map((id) => id.toString()) || [],
    commentCount: page.commentCount || 0,
    extended: page.extended,
    createdAt: toISOStringOrNull(page.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toISOStringOrNull(page.updatedAt) ?? undefined,
    latestRevision: pageObj.latestRevision?.toString(),
    // `likerCount` / `seenUsersCount` are dynamic properties set by
    // populatePageData on the Mongoose document and are NOT serialized into
    // toObject() output. Read them off the document directly.
    likerCount: page.likerCount,
    seenUsersCount: page.seenUsersCount,
  };
  return result;
  /* eslint-enable @typescript-eslint/no-explicit-any */
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');
  const User = crowi.model('User');

  // seenUsersCount stays at the raw ID-array length (matching legacy
  // populatePageData) so inactive users dropped by findUsersByIds' status
  // filter do not deflate the count.
  const buildSeenUsersResponse = async (seenUserIds: ReadonlyArray<unknown>) => {
    const ids = seenUserIds.filter((id) => id != null);
    const seenUsersCount = ids.length;

    if (ids.length === 0) {
      return { seenUsers: [] as UserPublic[], seenUsersCount };
    }

    const populated = (await User.findUsersByIds(ids)) as UserDocument[];
    return {
      seenUsers: populated.map(toUserPublic),
      seenUsersCount,
    };
  };

  const pageRouter = s.router(apiContract.page, {
    /**
     * GET /api/v2/pages
     * Get page data by path or page_id
     * - Supports optional revision_id for historical revisions
     * - Requires authentication (loginRequired middleware applied at router level)
     * - Checks page permissions (grant)
     */
    getPage: async ({ query, req }) => {
      const user = req.user as UserDocument;
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
      const user = req.user as UserDocument;
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

          // findListByCreator doesn't populate creator/lastUpdateUser, so we need to do it manually
          const rawPages = await Page.findListByCreator(targetUser, { limit, offset }, user);
          pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];
        } else if (path && path !== '/') {
          // List pages by path and get portal page
          debug('Finding pages by path:', path);
          debug('Query params:', { limit, offset, path, userParam });
          const [rawPortalPage, rawPages] = await Promise.all([Page.findPortalPage(path, user), Page.findListByStartWith(path, user, { limit, offset })]);
          // findListByStartWith doesn't populate creator/lastUpdateUser, so we need to do it manually
          [portalPage, pages] = (await Promise.all([
            rawPortalPage ? Page.populate(rawPortalPage, [{ path: 'creator' }, { path: 'lastUpdateUser' }]) : null,
            Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }]),
          ])) as [PageDocument | null, PageDocument[]];
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
    createPage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { path, body, grant } = requestBody;

      debug('createPage called with:', { path, grant, userId: user._id });

      if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
        return invalidGrantResponse();
      }

      try {
        const existing = await Page.findPage(path, user, null, /* ignoreNotFound */ true);
        if (existing !== null) {
          return {
            status: 400 as const,
            body: { error: { code: 'PAGE_EXISTS', message: 'Page exists' } },
          };
        }

        const createOptions: { grant?: number } = grant !== undefined ? { grant } : {};
        const created = (await Page.createPage(path, body, user, createOptions)) as PageDocument | null;

        if (!created) {
          throw new Error('Failed to create page.');
        }

        const populated = await Page.populatePageData(created, null);
        return { status: 200 as const, body: { page: pageToResponse(populated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error creating page:', error.message);

        if (error.message === 'Cannot create non existent user page.') {
          return {
            status: 400 as const,
            body: { error: { code: 'NON_EXISTENT_USER_PAGE', message: error.message } },
          };
        }

        // Both 'existed path' and 'not granted' map to PAGE_EXISTS: the latter
        // can occur as a race when a stricter-grant page is created between
        // findPage and createPage, and we should not leak that distinction.
        if (error.message === 'Cannot create new page to existed path' || error.message === 'Page is not granted for the user') {
          return {
            status: 400 as const,
            body: { error: { code: 'PAGE_EXISTS', message: 'Page exists' } },
          };
        }

        return {
          status: 400 as const,
          body: { error: { code: 'PAGE_CREATE_FAILED', message: error.message || 'Failed to create page' } },
        };
      }
    },
    updatePage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id, body, revision_id, grant } = requestBody;

      debug('updatePage called with:', { page_id, revision_id, grant, userId: user._id });

      if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
        return invalidGrantResponse();
      }

      try {
        const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!pageData) {
          return pageNotFoundResponse;
        }

        if (revision_id && !pageData.isUpdatable(revision_id)) {
          return {
            status: 409 as const,
            body: { error: { code: 'PAGE_REVISION_ERROR' as const, message: 'Revision error.' } },
          };
        }

        const grantOption = { grant: grant ?? pageData.grant };
        const updated = (await Page.updatePage(pageData, body, user, grantOption)) as PageDocument;

        const populated = await Page.populatePageData(updated, null);
        return { status: 200 as const, body: { page: pageToResponse(populated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error updating page:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return pageNotFoundResponse;
        }

        return {
          status: 400 as const,
          body: { error: { code: 'PAGE_UPDATE_FAILED', message: error.message || 'Failed to update page' } },
        };
      }
    },
    // Idempotent: Page.seen uses addToSet so re-posting from the same user
    // does not inflate seenUsers / seenUsersCount.
    seenPage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('seenPage called with:', { page_id, userId: user._id });

      const loaded = await loadGrantedPage(Page, page_id, user);
      if ('error' in loaded) return loaded.error;

      const updated = (await loaded.page.seen(user)) as PageDocument;
      return { status: 200 as const, body: await buildSeenUsersResponse(updated.seenUsers) };
    },

    getSeenUsers: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = query;

      debug('getSeenUsers called with:', { page_id, userId: user._id });

      const loaded = await loadGrantedPage(Page, page_id, user);
      if ('error' in loaded) return loaded.error;

      return { status: 200 as const, body: await buildSeenUsersResponse(loaded.page.seenUsers) };
    },
    /**
     * POST /api/v2/pages/like
     * Add the current user to the page's `liker` list.
     * - Idempotent: liking an already-liked page returns the page unchanged.
     * - Returns 404 (not 200 with no-op) when the page does not exist or
     *   the caller has no grant, matching the rest of the page contract
     *   (cf. updatePage / renamePage). The legacy /_api/likes.add returned
     *   ApiResponse.success() on errors, but that path was effectively
     *   unreachable in the legacy UI; see openQuestions in the task plan.
     */
    likePage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('likePage called with:', { page_id, userId: user._id });

      const loaded = await loadGrantedPage(Page, page_id, user);
      if ('error' in loaded) return loaded.error;

      // pageData.like is a no-op when the user already liked the page. Always
      // re-populate so the response shape stays stable either way.
      await loaded.page.like(user);
      const populated = await Page.populatePageData(loaded.page, null);
      return { status: 200 as const, body: { page: pageToResponse(populated) } };
    },

    /**
     * POST /api/v2/pages/unlike
     * Remove the current user from the page's `liker` list.
     * - Idempotent: unliking a not-liked page returns the page unchanged.
     * - Returns 404 for not-found / not-granted, mirroring likePage.
     */
    unlikePage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('unlikePage called with:', { page_id, userId: user._id });

      const loaded = await loadGrantedPage(Page, page_id, user);
      if ('error' in loaded) return loaded.error;

      // unlike is a no-op when the user had not liked the page. Always
      // re-populate so the response shape stays stable either way.
      await loaded.page.unlike(user);
      const populated = await Page.populatePageData(loaded.page, null);
      return { status: 200 as const, body: { page: pageToResponse(populated) } };
    },
    deletePage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id, revision_id, completely } = requestBody;

      debug('deletePage called with:', { page_id, revision_id, completely, userId: user._id });

      try {
        const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!pageData) {
          return pageNotFoundResponse;
        }

        // Hard delete bypasses revision check (matches old controllers/page.ts api.remove).
        if (completely === true) {
          await Page.completelyDeletePage(pageData, user);
          // After completelyDeletePage the document is gone from Mongo; we still
          // return the in-memory pageData so the client knows what was deleted.
          return { status: 200 as const, body: { page: pageToResponse(pageData) } };
        }

        if (revision_id && !pageData.isUpdatable(revision_id)) {
          return {
            status: 409 as const,
            body: { error: { code: 'PAGE_REVISION_ERROR' as const, message: 'Revision error.' } },
          };
        }

        // Page.deletePage mutates pageData (status -> deleted, path -> /trash/<path>)
        // and internally calls Page.rename which returns the *redirect* page (a quirk
        // of the old model). We re-populate the mutated pageData so the response
        // reflects the soft-deleted page itself, which is what callers actually want.
        await Page.deletePage(pageData, user);
        const populated = await Page.populatePageData(pageData, null);
        return { status: 200 as const, body: { page: pageToResponse(populated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error deleting page:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return pageNotFoundResponse;
        }

        return {
          status: 400 as const,
          body: { error: { code: 'PAGE_DELETE_FAILED', message: error.message || 'Failed to delete page' } },
        };
      }
    },
    revertDeletedPage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id } = requestBody;

      debug('revertDeletedPage called with:', { page_id, userId: user._id });

      try {
        const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!pageData) {
          return pageNotFoundResponse;
        }

        // Page.revertDeletedPage mutates pageData (path -> non-trash, status -> published)
        // and removes the redirect stub at the original /trash path. The function returns
        // pageData itself, but we re-populate to ensure creator/lastUpdateUser/revision are
        // resolved for the response.
        await Page.revertDeletedPage(pageData, user);
        const populated = await Page.populatePageData(pageData, null);
        return { status: 200 as const, body: { page: pageToResponse(populated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error reverting deleted page:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return pageNotFoundResponse;
        }

        return {
          status: 400 as const,
          body: { error: { code: 'PAGE_REVERT_FAILED', message: error.message || 'Failed to revert deleted page' } },
        };
      }
    },
    renamePage: async ({ body: requestBody, req }) => {
      const user = req.user as UserDocument;
      const { page_id, new_path, revision_id, create_redirect } = requestBody;

      debug('renamePage called with:', { page_id, new_path, revision_id, create_redirect, userId: user._id });

      // Normalize the destination path and validate the name first so we can
      // reject obviously bad inputs without touching the DB.
      const newPagePath = Page.normalizePath(new_path);
      const newPageIsPortal = newPagePath.endsWith('/');

      if (!Page.isCreatableName(newPagePath)) {
        return {
          status: 400 as const,
          body: {
            error: {
              code: 'PAGE_INVALID_NAME',
              message: `Cannot rename to this page name (${newPagePath})`,
            },
          },
        };
      }

      try {
        // Authorization: same pattern as updatePage. Hide existence from
        // callers without grant by returning 404.
        const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!pageData) {
          return pageNotFoundResponse;
        }

        if (revision_id && !pageData.isUpdatable(revision_id)) {
          return {
            status: 409 as const,
            body: { error: { code: 'PAGE_REVISION_ERROR' as const, message: 'Revision error.' } },
          };
        }

        // Detect collision at the destination path. If the existing page is a
        // redirect that the user is allowed to remove, unlink it first;
        // otherwise refuse the rename. This mirrors controllers/page.ts.
        const existingAtNewPath = await Page.findOne({ path: newPagePath });
        if (existingAtNewPath) {
          if (existingAtNewPath.isUnlinkable(user)) {
            try {
              await existingAtNewPath.unlink(user);
            } catch (err) {
              const error = err as Error;
              return {
                status: 400 as const,
                body: {
                  error: {
                    code: 'PAGE_RENAME_FAILED',
                    message: error.message || 'Failed to unlink redirect page at destination',
                  },
                },
              };
            }
          } else {
            return {
              status: 400 as const,
              body: {
                error: {
                  code: 'PAGE_EXISTS',
                  message: `Cannot rename to this page name (${newPagePath}). Page exists.`,
                },
              },
            };
          }
        }

        // Old controller: `(!newPageIsPortal && createRedirect) || 0` — portal
        // paths (ending in '/') never get a redirect page even if requested.
        const options = {
          createRedirectPage: !newPageIsPortal && Boolean(create_redirect),
        };

        await Page.rename(pageData, newPagePath, user, options);

        const populated = await Page.populatePageData(pageData, null);
        return { status: 200 as const, body: { page: pageToResponse(populated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error renaming page:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return pageNotFoundResponse;
        }

        return {
          status: 400 as const,
          body: { error: { code: 'PAGE_RENAME_FAILED', message: error.message || 'Failed to rename page' } },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.page, pageRouter, router);

  return router;
};
