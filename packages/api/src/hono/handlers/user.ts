/**
 * RFC-0006 Phase 4 Batch 2 — `user` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/user.ts`. Four endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/user/*`:
 *
 *   GET /user/:username             — profile + recent activity
 *   GET /user/:username/bookmarks   — paginated bookmarks
 *   GET /user/:username/pages       — paginated created (creator-rooted) pages
 *   GET /user/:username/subpages    — paginated /user/:username/* pages (path-rooted)
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
 * The `pages` (creator-rooted) and `subpages` (path-rooted) endpoints are
 * deliberately different sets: `pages` is "pages this user wrote" (any
 * path); `subpages` is "pages that live under /user/<username>/" (any
 * creator). Both respect the same `visiblePageStatusOr` + grant policy —
 * see `findSubpagesByUserNamespace` (`src/models/page.ts`) for the
 * subpages-specific query.
 */
import { getUserBookmarksRoute, getUserPageRoute, getUserPagesRoute, getUserSubpagesRoute, listMembersRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { BookmarkDocument } from 'src/models/bookmark';
import { creatorPageListMatch, type PageDocument } from 'src/models/page';
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
  const Comment = crowi.model('Comment');

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
  // `getUserSubpagesRoute` requires BOTH scopes (AND): `profile:read`
  // because resolving `{username}` is a profile-namespace lookup (same as
  // the three routes above), and `pages:read` because the payload is a
  // listing of page resources (same scope every other page-listing route
  // requires). Two `applyScope` calls on the SAME route register two
  // independent `requireScope` middlewares on the same method+routing-path;
  // Hono runs method-scoped middleware in registration order via `next()`,
  // so either guard failing short-circuits before the other guard / the
  // handler runs — i.e. the stack is AND, not OR. This relies on
  // `applyScope` registering on `route.getRoutingPath()` (not the OpenAPI
  // `{username}` form) so it actually matches the real request path.
  applyScope(app, getUserSubpagesRoute, 'profile:read');
  applyScope(app, getUserSubpagesRoute, 'pages:read');

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

        // Four independent counts, all resolved via DB-side countDocuments
        // on an indexed field — run them in parallel (feature-profile-
        // stats-and-page-total, matching the established
        // findSubpagesByUserNamespace / ListUsersResponseSchema.total
        // convention). `likesCount` / `commentsCount` are the target
        // user's OWN actions (pages they liked, comments they wrote) —
        // NOT activity their own pages received — so neither is filtered
        // by the current viewer's grants (see spec §プロフィール統計の主語).
        const [createdPagesCount, bookmarksCount, likesCount, commentsCount] = await Promise.all([
          Page.countDocuments(creatorPageListMatch(targetUser._id, currentUser._id)),
          Bookmark.countDocuments({ user: targetUser._id }),
          Page.countDocuments({ liker: targetUser._id }),
          Comment.countDocuments({ creator: targetUser._id }),
        ]);

        const recentPagesRaw = await Page.findListByCreator(targetUser, { limit: 10, offset: 0 }, currentUser);
        const recentPages = (await Page.populate(recentPagesRaw, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

        const bookmarkResult = await Bookmark.findByUserId(targetUser._id, { limit: 10, offset: 0 });
        const recentBookmarks = bookmarkResult.data as BookmarkDocument[];

        return c.json(
          {
            user: toUserPublic(targetUser),
            createdPagesCount,
            bookmarksCount,
            likesCount,
            commentsCount,
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

        // find + count share `creatorPageListMatch` and run in parallel —
        // same convention as the creator branch in listPages (page.ts).
        const [rawPages, total] = await Promise.all([
          Page.findListByCreator(targetUser, { limit, offset }, currentUser),
          Page.countDocuments(creatorPageListMatch(targetUser._id, currentUser._id)),
        ]);
        const pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

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
    .openapi(getUserSubpagesRoute, async (c) => {
      const currentUser = c.get('user');
      const { username } = c.req.valid('param');
      const { limit, offset } = c.req.valid('query');

      debug('getUserSubpages called with:', { username, limit, offset, currentUserId: currentUser._id });

      try {
        const targetUser = await User.findUserByUsername(username);
        if (!targetUser || !isViewableUserStatus(targetUser.status)) {
          return c.json(USER_NOT_FOUND_BODY, 404);
        }

        // Canonical prefix comes from the RESOLVED `targetUser.username`,
        // not the raw route param, so casing/normalization quirks in the
        // URL never diverge from the stored path prefix.
        const prefix = `/user/${targetUser.username}/`;
        const { rawPages, total } = await Page.findSubpagesByUserNamespace(prefix, currentUser._id, { limit, offset });
        const pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];

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
        debug('Error fetching user subpages:', error.message, error.stack);
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
