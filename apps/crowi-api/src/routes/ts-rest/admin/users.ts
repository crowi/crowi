import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { createPager, MAX_PAGE_LIST } from 'src/util/admin-pager';
import { internalServerErrorResponse, toUserPublic } from 'src/util/ts-rest-helpers';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:users');

/**
 * Default sort + projection used by the admin list page. Mirrors the
 * `findUsersWithPagination` static defined in `models/user.ts` (which
 * the legacy controller still uses); replicated here so the new ts-rest
 * handler can call `User.paginate` directly (Promise form) without
 * routing through the callback-only static.
 */
const ADMIN_PAGINATE_SORT = { status: 1, username: 1, createdAt: 1 } as const;
const ADMIN_PAGINATE_SELECT = '-password -apiToken -googleId -githubId';

/**
 * Build the Mongo `$or` filter for the free-text search.
 *
 * Mirrors the legacy controller (admin.ts:232-240): a single space splits
 * the query into two regex alternatives so "alice bob" matches either
 * 'alice' OR 'bob'. Each token is regex-escaped (same approach as
 * `models/user.ts:findUsersByPartOfEmail`) so user input like '(' or '.'
 * doesn't either crash with `SyntaxError` or match more than expected.
 *
 * Returns an empty filter when the trimmed query is blank.
 */
const REGEX_META = /[-/\\^$*+?.()|[\]{}]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_META, '\\$&');

function buildSearchFilter(q: string | undefined): { $or?: Record<string, { $regex: string; $options: string }>[] } {
  if (!q) return {};
  const trimmed = q.trim();
  if (trimmed.length === 0) return {};
  const firstSpace = trimmed.indexOf(' ');
  const $regex = firstSpace === -1 ? escapeRegex(trimmed) : `${escapeRegex(trimmed.slice(0, firstSpace))}|${escapeRegex(trimmed.slice(firstSpace + 1))}`;
  return {
    $or: ['username', 'name', 'email'].map((field) => ({
      [field]: { $regex, $options: 'i' },
    })),
  };
}

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const User = crowi.model('User');

  const usersRouter = s.router(apiContract.admin.users, {
    /**
     * GET /api/v2/admin/users
     *
     * Returns a paged slice of users plus a numbered pager, replacing the
     * legacy `Admin.api.user.index`. The previous endpoint streamed full
     * UserDocument shapes (including password / apiToken / googleId /
     * githubId) — we narrow to UserPublic here so secrets never escape the
     * admin boundary.
     *
     * Authorization: handled by the surrounding `jwtAdminRequired` middleware.
     */
    listUsers: async ({ query }) => {
      const { q, page, limit } = query;

      try {
        const filter = buildSearchFilter(q);
        const result = await User.paginate(filter, {
          page,
          limit,
          sort: ADMIN_PAGINATE_SORT,
          select: ADMIN_PAGINATE_SELECT,
        });
        const pager = createPager(result.total, result.page ?? page, result.pages, MAX_PAGE_LIST);

        return {
          status: 200 as const,
          body: {
            users: result.docs.map(toUserPublic),
            pager,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing users:', error.message);
        return internalServerErrorResponse;
      }
    },

    /**
     * GET /api/v2/admin/users/search
     *
     * Email-substring autocomplete. The legacy endpoint returned at most
     * PAGE_ITEMS+1 (= 51) results so the caller can detect "more matches than
     * shown"; the underlying `User.findUsersByPartOfEmail` already enforces
     * that limit.
     */
    searchUsersByEmail: async ({ query }) => {
      try {
        const users: UserDocument[] = await User.findUsersByPartOfEmail(query.email, {});
        return {
          status: 200 as const,
          body: { users: users.map(toUserPublic) },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error searching users by email:', error.message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.admin.users, usersRouter, router);
  return router;
};
