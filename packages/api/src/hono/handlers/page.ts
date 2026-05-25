/**
 * RFC-0006 Phase 4 Batch 4 — `page` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/page.ts`. 14 endpoints —
 * the largest single resource in the API. Wire-format parity with the
 * ts-rest era is preserved byte-for-byte (response shapes, error
 * envelopes, status codes, idempotency / leak-guard semantics).
 *
 * **jwtAuth ownership** (important):
 *
 *   The `revision` handler already installs
 *     app.use('/pages/*', createJwtAuth(crowi));
 *     app.use('/pages',   createJwtAuth(crowi));
 *   on the shared chain (see
 *   `packages/api/src/hono/handlers/revision.ts`). Hono does NOT dedupe
 *   middleware by reference — re-installing the same factory output on
 *   the same prefix would run JWT verify + `User.findById` twice per
 *   request. The page handler relies on the revision handler having
 *   registered first in `buildHonoApp`, and does NOT install jwtAuth
 *   itself. Phase 6 will revisit this implicit ordering when the
 *   Express bridge is removed.
 */
import {
  createPageRoute,
  deletePageRoute,
  getPageRoute,
  getSeenUsersRoute,
  getWatchStatusRoute,
  likePageRoute,
  listPagesRoute,
  PageGrantEnum,
  renamePageRoute,
  revertDeletedPageRoute,
  seenPageRoute,
  setPageGrantRoute,
  setWatchStatusRoute,
  type UserPublic,
  unlikePageRoute,
  updatePageRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { type PageDocument, visiblePageGrantOr, visiblePageStatusOr } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { computeRevisionRenderArtifactsAsync, isPopulatedRevision, pageToResponse } from 'src/util/page-response';
import { isValidObjectId, loadGrantedPage, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';

import { INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:page');

const VALID_GRANTS: number[] = Object.values(PageGrantEnum);

const PAGE_NOT_GRANTED_BODY = {
  error: { code: 'PAGE_NOT_GRANTED' as const, message: 'Page is not granted for the user' as const },
};

const INVALID_GRANT_BODY = {
  error: {
    code: 'INVALID_GRANT' as const,
    message: 'grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)' as const,
  },
};

// Build a 400 PAGE_* envelope without losing the literal narrowing on
// the `code` field (the contract widens `code` to `z.string()` for this
// resource so the helper keeps it simple).
const pageBadRequestBody = (code: string, message: string) => ({
  error: { code, message },
});

const pageRevisionConflictBody = () => ({
  error: { code: 'PAGE_REVISION_ERROR' as const, message: 'Revision error.' },
});

export const registerPageRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const User = crowi.model('User');
  const Watcher = crowi.model('Watcher');

  /**
   * Build the seen-users response. `seenUsersCount` reflects the full
   * raw id-array length (matching the legacy `populatePageData`) so
   * inactive users dropped by `findUsersByIds`' status filter do not
   * deflate the count. `limit` only caps the returned `seenUsers` list.
   */
  const buildSeenUsersResponse = async (seenUserIds: ReadonlyArray<unknown>, limit?: number) => {
    const ids = seenUserIds.filter((id) => id != null);
    const seenUsersCount = ids.length;

    if (ids.length === 0) {
      return { seenUsers: [] as UserPublic[], seenUsersCount };
    }

    const idsToFetch = limit !== undefined ? ids.slice(0, limit) : ids;
    const populated = (await User.findUsersByIds(idsToFetch)) as UserDocument[];
    return {
      seenUsers: populated.map(toUserPublic),
      seenUsersCount,
    };
  };

  return (
    app
      // --------------------------------------------------------------
      // GET /pages — getPage (path-or-id)
      // --------------------------------------------------------------
      .openapi(getPageRoute, async (c) => {
        const user = c.get('user');
        const { path, page_id, revision_id } = c.req.valid('query');

        debug('getPage called with:', { path, page_id, revision_id, userId: user._id });

        if (!path && !page_id) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        try {
          let page: PageDocument | null = null;

          // page_id takes precedence over path (legacy controller order).
          if (page_id) {
            page = await Page.findPageByIdAndGrantedUser(page_id, user);
          } else if (path) {
            page = await Page.findPage(path, user, revision_id || null);
          }

          if (!page) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const pageResponse = pageToResponse(page, { withMeta: true, withRenderedAst: true });

          // On-the-fly fallback for legacy revisions — one pipeline run
          // produces both meta + renderedAst, stored values win on merge.
          if (pageResponse.revision && isPopulatedRevision(page.revision)) {
            const { meta, renderedAst } = await computeRevisionRenderArtifactsAsync(
              crowi,
              page.revision.meta,
              page.revision.renderedAst,
              page.revision.body,
              page.revision.rendererVersion,
              page._id?.toString(),
            );
            pageResponse.revision.meta = meta;
            pageResponse.revision.renderedAst = renderedAst;
          }

          // Fire-and-forget recently-viewed touch — Redis hiccups must
          // not block the page read.
          crowi.lru.add(user._id.toString(), page._id.toString())?.catch?.((err: unknown) => {
            debug('lru.add failed (non-fatal):', err);
          });

          return c.json({ page: pageResponse }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error fetching page:', error.message);

          if (error.message === 'Page not found' || error.name === 'Crowi:Page:NotFound') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_GRANTED_BODY, 403);
          }
          // Legacy fallback — unknown errors collapse to PAGE_NOT_FOUND.
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/list — listPages
      // --------------------------------------------------------------
      .openapi(listPagesRoute, async (c) => {
        const user = c.get('user');
        const { path, user: userParam, limit, offset, include_deleted } = c.req.valid('query');

        // Force-enable include_deleted for /trash and /trash/<sub> requests so
        // the legacy deletedPageListShow semantics are preserved even when
        // the client omits the query flag.
        const isTrashPath = !!path && (path === '/trash' || path.startsWith('/trash/'));
        const includeDeletedPage = include_deleted || isTrashPath;

        debug('listPages called with:', { path, user: userParam, limit, offset, includeDeletedPage, userId: user._id });

        try {
          let pages: PageDocument[] = [];
          let portalPage: PageDocument | null = null;

          if (userParam) {
            // List pages by creator.
            const targetUser = await User.findById(userParam);
            if (!targetUser) {
              return c.json(
                {
                  pages: [],
                  pager: { prev: null, next: null, offset: 0 },
                  portalPage: null,
                },
                200,
              );
            }

            const rawPages = await Page.findListByCreator(targetUser, { limit, offset }, user);
            pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];
          } else if (path && path !== '/') {
            // List pages by path. /trash subtrees skip findPortalPage to
            // mirror the legacy deletedPageListShow which always rendered
            // with page=null.
            const portalPagePromise = isTrashPath ? Promise.resolve(null) : Page.findPortalPage(path, user);
            const listPromise = Page.findListByStartWith(path, user, { limit, offset, includeDeletedPage });
            const [rawPortalPage, rawPages] = await Promise.all([portalPagePromise, listPromise]);
            [portalPage, pages] = (await Promise.all([
              rawPortalPage ? Page.populate(rawPortalPage, [{ path: 'creator' }, { path: 'lastUpdateUser' }]) : null,
              Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }]),
            ])) as [PageDocument | null, PageDocument[]];
          } else {
            // List all pages the user can access (including path='/').
            //
            // Both visibility predicates come from the Page model:
            //   visiblePageStatusOr — published + the viewer's own drafts
            //   visiblePageGrantOr  — public + restricted/specified/owner
            //                         pages where the viewer is in
            //                         grantedUsers
            //
            // Previously this branch hard-coded `grant: { $in: [1, 2] }`,
            // which (a) silently dropped GRANT_OWNER and GRANT_SPECIFIED
            // pages the viewer creates or is granted, and (b) leaked
            // GRANT_RESTRICTED pages to non-members because the
            // grantedUsers check was missing. Replacing both predicates
            // with the model helpers keeps the path-based and root /
            // no-path branches consistent.
            // biome-ignore lint/suspicious/noExplicitAny: legacy Mongoose conditions shape
            const conditions: any = {
              redirectTo: null,
              $and: [{ $or: visiblePageStatusOr(user._id) }, { $or: visiblePageGrantOr(user._id) }],
            };

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

          const pageResponses = pages.map((page) => pageToResponse(page));
          const portalPageResponse = portalPage ? pageToResponse(portalPage) : null;

          const prev = offset > 0 ? Math.max(0, offset - limit) : null;
          const next = pages.length === limit ? offset + limit : null;

          return c.json(
            {
              pages: pageResponses,
              pager: { prev, next, offset },
              portalPage: portalPageResponse,
            },
            200,
          );
        } catch (err) {
          debug('Error listing pages:', (err as Error).message);
          // Legacy behaviour: an unexpected error collapses to an empty
          // list rather than 500. Preserved for wire compatibility.
          return c.json(
            {
              pages: [],
              pager: { prev: null, next: null, offset: 0 },
              portalPage: null,
            },
            200,
          );
        }
      })
      // --------------------------------------------------------------
      // POST /pages — createPage
      // --------------------------------------------------------------
      .openapi(createPageRoute, async (c) => {
        const user = c.get('user');
        const { path, body, grant } = c.req.valid('json');

        debug('createPage called with:', { path, grant, userId: user._id });

        if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        try {
          const existing = await Page.findPage(path, user, null, /* ignoreNotFound */ true);
          if (existing !== null) {
            return c.json(pageBadRequestBody('PAGE_EXISTS', 'Page exists'), 400);
          }

          const createOptions: { grant?: number } = grant !== undefined ? { grant } : {};
          const created = (await Page.createPage(path, body, user, createOptions)) as PageDocument | null;
          if (!created) {
            throw new Error('Failed to create page.');
          }

          const populated = await Page.populatePageData(created, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error creating page:', error.message);

          if (error.message === 'Cannot create non existent user page.') {
            return c.json(pageBadRequestBody('NON_EXISTENT_USER_PAGE', error.message), 400);
          }
          // Both 'existed path' and 'not granted' collapse to PAGE_EXISTS
          // — the latter is a stricter-grant race we must not leak.
          if (error.message === 'Cannot create new page to existed path' || error.message === 'Page is not granted for the user') {
            return c.json(pageBadRequestBody('PAGE_EXISTS', 'Page exists'), 400);
          }
          return c.json(pageBadRequestBody('PAGE_CREATE_FAILED', error.message || 'Failed to create page'), 400);
        }
      })
      // --------------------------------------------------------------
      // PUT /pages — updatePage
      // --------------------------------------------------------------
      .openapi(updatePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, body, revision_id, grant } = c.req.valid('json');

        debug('updatePage called with:', { page_id, revision_id, grant, userId: user._id });

        if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          const grantOption = { grant: grant ?? pageData.grant };
          const updated = (await Page.updatePage(pageData, body, user, grantOption)) as PageDocument;
          const populated = await Page.populatePageData(updated, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error updating page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_UPDATE_FAILED', error.message || 'Failed to update page'), 400);
        }
      })
      // --------------------------------------------------------------
      // PUT /pages/grant — setPageGrant
      // --------------------------------------------------------------
      .openapi(setPageGrantRoute, async (c) => {
        const user = c.get('user');
        const { page_id, grant } = c.req.valid('json');

        debug('setPageGrant called with:', { page_id, grant, userId: user._id });

        if (!VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const updated = (await Page.updateGrant(pageData, grant, user)) as PageDocument;
          const populated = await Page.populatePageData(updated, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error updating page grant:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_GRANT_UPDATE_FAILED', error.message || 'Failed to update page grant'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/seen — seenPage (idempotent via Page.seen addToSet)
      // --------------------------------------------------------------
      .openapi(seenPageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('seenPage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) return c.json(PAGE_NOT_FOUND_BODY, 404);

        const updated = (await loaded.page.seen(user)) as PageDocument;
        return c.json(await buildSeenUsersResponse(updated.seenUsers), 200);
      })
      // --------------------------------------------------------------
      // GET /pages/seen-users — getSeenUsers
      // --------------------------------------------------------------
      .openapi(getSeenUsersRoute, async (c) => {
        const user = c.get('user');
        const { page_id, limit } = c.req.valid('query');

        debug('getSeenUsers called with:', { page_id, limit, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        return c.json(await buildSeenUsersResponse(loaded.page.seenUsers, limit), 200);
      })
      // --------------------------------------------------------------
      // POST /pages/like — likePage
      // --------------------------------------------------------------
      .openapi(likePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('likePage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        // `like` is a no-op when the user already liked the page.
        await loaded.page.like(user);
        const populated = await Page.populatePageData(loaded.page, null);
        return c.json({ page: pageToResponse(populated) }, 200);
      })
      // --------------------------------------------------------------
      // POST /pages/unlike — unlikePage
      // --------------------------------------------------------------
      .openapi(unlikePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('unlikePage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        await loaded.page.unlike(user);
        const populated = await Page.populatePageData(loaded.page, null);
        return c.json({ page: pageToResponse(populated) }, 200);
      })
      // --------------------------------------------------------------
      // GET /pages/watch — getWatchStatus
      // --------------------------------------------------------------
      .openapi(getWatchStatusRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('query');

        debug('getWatchStatus called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        const watcher = await Watcher.findByUserIdAndTargetId(user._id, loaded.page._id);
        if (watcher) {
          return c.json({ watching: watcher.isWatching() }, 200);
        }

        // Default: derive from getNotificationTargetUsers (creator +
        // comment authors + revision authors).
        const targetUsers = await loaded.page.getNotificationTargetUsers();
        const userIdStr = user._id.toString();
        const watching = targetUsers.some((id) => id.toString() === userIdStr);
        return c.json({ watching }, 200);
      })
      // --------------------------------------------------------------
      // PUT /pages/watch — setWatchStatus (2-state: WATCH / IGNORE)
      // --------------------------------------------------------------
      .openapi(setWatchStatusRoute, async (c) => {
        const user = c.get('user');
        const { page_id, watching } = c.req.valid('json');

        debug('setWatchStatus called with:', { page_id, watching, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        const status = watching ? Watcher.STATUS_WATCH : Watcher.STATUS_IGNORE;
        await Watcher.watchByPageId(user._id, loaded.page._id, status);
        return c.json({ watching }, 200);
      })
      // --------------------------------------------------------------
      // DELETE /pages — deletePage (soft / hard with completely=true)
      // --------------------------------------------------------------
      .openapi(deletePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, revision_id, completely } = c.req.valid('json');

        debug('deletePage called with:', { page_id, revision_id, completely, userId: user._id });

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          if (completely === true) {
            // Hard delete bypasses the revision check (legacy parity).
            await Page.completelyDeletePage(pageData, user);
            // The document is gone from Mongo; echo the in-memory snapshot
            // so the client knows what was deleted.
            return c.json({ page: pageToResponse(pageData) }, 200);
          }

          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          // Page.deletePage mutates `pageData` (status -> deleted, path
          // -> /trash/<path>); the returned value is the *redirect* page
          // (a quirk of the legacy model). Re-populate the mutated
          // pageData so the response reflects the soft-deleted page
          // itself, which is what clients want.
          await Page.deletePage(pageData, user);
          const populated = await Page.populatePageData(pageData, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error deleting page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_DELETE_FAILED', error.message || 'Failed to delete page'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/revert — revertDeletedPage
      // --------------------------------------------------------------
      .openapi(revertDeletedPageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('revertDeletedPage called with:', { page_id, userId: user._id });

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // Mutates pageData (path -> non-trash, status -> published)
          // and removes the redirect stub at the original /trash path.
          await Page.revertDeletedPage(pageData, user);
          const populated = await Page.populatePageData(pageData, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error reverting deleted page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_REVERT_FAILED', error.message || 'Failed to revert deleted page'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/rename — renamePage
      // --------------------------------------------------------------
      .openapi(renamePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, new_path, revision_id, create_redirect } = c.req.valid('json');

        debug('renamePage called with:', { page_id, new_path, revision_id, create_redirect, userId: user._id });

        // Normalise the destination path first so obviously-bad inputs
        // are rejected without touching the DB.
        const newPagePath = Page.normalizePath(new_path);
        const newPageIsPortal = newPagePath.endsWith('/');

        if (!Page.isCreatableName(newPagePath)) {
          return c.json(pageBadRequestBody('PAGE_INVALID_NAME', `Cannot rename to this page name (${newPagePath})`), 400);
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          // Collision at the destination path — unlink an existing
          // redirect when the caller has permission, otherwise refuse.
          const existingAtNewPath = await Page.findOne({ path: newPagePath });
          if (existingAtNewPath) {
            if (existingAtNewPath.isUnlinkable(user)) {
              try {
                await existingAtNewPath.unlink(user);
              } catch (err) {
                const error = err as Error;
                return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', error.message || 'Failed to unlink redirect page at destination'), 400);
              }
            } else {
              return c.json(pageBadRequestBody('PAGE_EXISTS', `Cannot rename to this page name (${newPagePath}). Page exists.`), 400);
            }
          }

          // Legacy controller: portal paths (ending in '/') never get a
          // redirect page even if requested.
          const options = {
            createRedirectPage: !newPageIsPortal && Boolean(create_redirect),
          };

          await Page.rename(pageData, newPagePath, user, options);

          const populated = await Page.populatePageData(pageData, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error renaming page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', error.message || 'Failed to rename page'), 400);
        }
      })
  );
};
