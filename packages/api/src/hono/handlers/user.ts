/**
 * RFC-0006 Phase 4 Batch 2 — `user` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/user.ts`. Three endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/user/*`:
 *
 *   GET /user/:username             — profile + recent activity
 *   GET /user/:username/bookmarks   — paginated bookmarks
 *   GET /user/:username/pages       — paginated created pages
 *
 * Wire-format parity is preserved. The legacy handlers checked `req.user`
 * manually and returned `AUTHENTICATION_REQUIRED`; the middleware does
 * that uniformly now so the per-handler guard goes away. The 404 envelope
 * (`USER_NOT_FOUND`) covers "no document" and non-viewable accounts
 * (deleted / invited / registered). Active *and* suspended users are shown:
 * a suspended author is gone, but the pages they wrote stay browseable under
 * /user/<username>/..., so hiding only the profile is a broken link, not
 * privacy.
 *
 * Both pagination endpoints respect the same `visiblePageStatusOr` +
 * `GRANT_PUBLIC` policy as the ts-rest version when viewing another
 * user's pages.
 */
import { getUserBookmarksRoute, getUserPageRoute, getUserPagesRoute, listMembersRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { BookmarkDocument } from 'src/models/bookmark';
import { type PageDocument, visiblePageStatusOr } from 'src/models/page';
import { type PageLike, pageToResponse } from 'src/util/page-response';
import { escapeRegExp } from 'src/util/regex';
import { type PopulatedUser, isPopulatedUser, toISOStringOrNull, toPageUser, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:user');

const USER_NOT_FOUND_BODY = {
  error: { code: 'USER_NOT_FOUND' as const, message: 'User not found' as const },
};

/**
 * Shape the ts-rest handler accepted for bookmark documents. Mirrors
 * `routes/ts-rest/user.ts` so the response shape is byte-identical.
 */
interface BookmarkLike {
  _id: Types.ObjectId | string;
  page?: PageLike | null;
  user: PopulatedUser | Types.ObjectId | string;
  createdAt?: Date;
  toObject?: () => BookmarkLike;
}

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

export const registerUserRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  // A user page stays reachable for ACTIVE and SUSPENDED accounts. A suspended
  // user is gone, but the pages they authored remain visible (they show up in
  // the page tree under /user/<username>/...), so 404-ing only their profile is
  // a broken link rather than real privacy. DELETED accounts are tombstoned
  // (renamed `deleted-<id>`, so the original username 404s anyway) and
  // INVITED / REGISTERED placeholders never had a real profile — all stay hidden.
  const isViewableUserStatus = (status: number): boolean => status === User.STATUS_ACTIVE || status === User.STATUS_SUSPENDED;

  // Every `/user/*` endpoint requires auth. Apply the middleware
  // broadly so each route below sees `c.get('user')` populated. The
  // member directory lives at the sibling path `/users` (plural), which
  // `/user/*` does not cover, so it gets its own auth apply.
  app.use('/user/*', createJwtAuth(crowi));
  app.use('/users', createJwtAuth(crowi));

  // RFC-0010 — public user pages + member directory are profile:read.
  applyScope(app, getUserPageRoute, 'profile:read');
  applyScope(app, getUserBookmarksRoute, 'profile:read');
  applyScope(app, getUserPagesRoute, 'profile:read');
  applyScope(app, listMembersRoute, 'profile:read');

  return app
    .openapi(getUserPageRoute, async (c) => {
      const currentUser = c.get('user');
      const { username } = c.req.valid('param');

      debug('getUserPage called with:', { username, currentUserId: currentUser._id });

      try {
        const targetUser = await User.findUserByUsername(username);
        if (!targetUser || !isViewableUserStatus(targetUser.status)) {
          return c.json(USER_NOT_FOUND_BODY, 404);
        }

        const isViewingSelf = currentUser._id.equals(targetUser._id);
        // Match `findListByCreator`'s visibility conditions.
        const pageCountConditions: Record<string, unknown> = {
          creator: targetUser._id,
          redirectTo: null,
          $or: visiblePageStatusOr(currentUser._id, targetUser._id),
        };
        if (!isViewingSelf) {
          pageCountConditions.grant = Page.GRANT_PUBLIC;
        }
        const createdPagesCount = await Page.countDocuments(pageCountConditions);
        const bookmarksCount = await Bookmark.countDocuments({ user: targetUser._id });

        const recentPagesRaw = await Page.findListByCreator(targetUser, { limit: 10, offset: 0 }, currentUser);
        const recentPages = (await Page.populate(recentPagesRaw, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit: 10, offset: 0 });
        const recentBookmarks = bookmarkResult.data as BookmarkDocument[];

        return c.json(
          {
            user: toUserPublic(targetUser),
            createdPagesCount,
            bookmarksCount,
            recentPages: recentPages.map((page) => pageToResponse(page)),
            recentBookmarks: recentBookmarks.filter((bookmark) => bookmark.page).map((bookmark) => bookmarkToResponse(bookmark)),
          },
          200,
        );
      } catch (err) {
        const error = err as Error;
        debug('Error fetching user page:', error.message, error.stack);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(getUserBookmarksRoute, async (c) => {
      const currentUser = c.get('user');
      const { username } = c.req.valid('param');
      const { limit, offset } = c.req.valid('query');

      debug('getUserBookmarks called with:', { username, limit, offset, currentUserId: currentUser._id });

      try {
        const targetUser = await User.findUserByUsername(username);
        if (!targetUser || !isViewableUserStatus(targetUser.status)) {
          return c.json(USER_NOT_FOUND_BODY, 404);
        }

        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit, offset });
        const bookmarks = bookmarkResult.data as BookmarkDocument[];
        const total = bookmarkResult.meta.total;

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
        const error = err as Error;
        debug('Error fetching user bookmarks:', error.message, error.stack);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(getUserPagesRoute, async (c) => {
      const currentUser = c.get('user');
      const { username } = c.req.valid('param');
      const { limit, offset } = c.req.valid('query');

      debug('getUserPages called with:', { username, limit, offset, currentUserId: currentUser._id });

      try {
        const targetUser = await User.findUserByUsername(username);
        if (!targetUser || !isViewableUserStatus(targetUser.status)) {
          return c.json(USER_NOT_FOUND_BODY, 404);
        }

        const rawPages = await Page.findListByCreator(targetUser, { limit, offset }, currentUser);
        const pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        const pageCountConditions: Record<string, unknown> = {
          creator: targetUser._id,
          redirectTo: null,
          $or: visiblePageStatusOr(currentUser._id, targetUser._id),
        };
        if (!currentUser._id.equals(targetUser._id)) {
          pageCountConditions.grant = Page.GRANT_PUBLIC;
        }
        const total = await Page.countDocuments(pageCountConditions);

        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return c.json(
          {
            pages: pages.map((page) => pageToResponse(page)),
            pager: { prev, next, offset },
            total,
          },
          200,
        );
      } catch (err) {
        const error = err as Error;
        debug('Error fetching user pages:', error.message, error.stack);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(listMembersRoute, async (c) => {
      const { q, limit, offset } = c.req.valid('query');

      debug('listMembers called with:', { q, limit, offset });

      try {
        const trimmed = q?.trim();
        const rx = trimmed ? { $regex: escapeRegExp(trimmed), $options: 'i' } : null;
        const filter: Record<string, unknown> = {
          status: User.STATUS_ACTIVE,
          ...(rx ? { $or: [{ username: rx }, { name: rx }] } : {}),
        };

        // count + page fetch are independent — run them together.
        const [total, users] = await Promise.all([
          User.countDocuments(filter),
          User.find(filter)
            .select('username name image')
            // Case-insensitive name ordering; `username` breaks ties so the
            // page boundaries are stable across requests. A compound index on
            // `{ name, username }` with this collation would back the sort if
            // the active-user set ever grows large enough to matter.
            .collation({ locale: 'en', strength: 2 })
            .sort({ name: 1, username: 1 })
            .skip(offset)
            .limit(limit)
            .exec() as Promise<Array<{ _id: Types.ObjectId | string; username: string; name: string; image?: string | null }>>,
        ]);

        const prev = offset > 0 ? Math.max(0, offset - limit) : null;
        const next = offset + limit < total ? offset + limit : null;

        return c.json(
          {
            users: users.map((u) => ({
              _id: toStringId(u._id),
              username: u.username,
              name: u.name,
              image: u.image ?? null,
            })),
            pager: { prev, next, offset },
            total,
          },
          200,
        );
      } catch (err) {
        const error = err as Error;
        debug('Error listing members:', error.message, error.stack);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
