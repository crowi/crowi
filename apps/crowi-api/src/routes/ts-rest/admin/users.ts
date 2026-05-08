import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type AdminPager } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { toUserPublic } from 'src/util/ts-rest-helpers';
import type { UserDocument, UserModel } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:users');

/**
 * Maximum number of numbered page buttons rendered around the current page.
 * Mirrors the legacy `MAX_PAGE_LIST = 5` in admin controller (admin.ts:16).
 */
const MAX_PAGE_LIST = 5;

/**
 * Build a pager bundle compatible with the legacy `createPager`
 * (apps/crowi-api/src/controllers/admin.ts:22-93). Re-implemented in the new
 * code path so the wire format stays identical and the new admin UI can
 * render the same numbered pager + dots without translation.
 *
 * Note: `pagesCount` may be 0 when there are no matching users; the windowing
 * loop below correctly emits an empty `pages` array in that case (pagerMin
 * collapses to 1 and pagerMax stays at 0, so the for-loop body never runs).
 */
function createPager(total: number, page: number, pagesCount: number, maxPageList: number): AdminPager {
  const pager: AdminPager = {
    page,
    pagesCount,
    pages: [],
    total,
    previous: null,
    previousDots: false,
    next: null,
    nextDots: false,
  };

  if (page > 1) {
    pager.previous = page - 1;
  }

  if (page < pagesCount) {
    pager.next = page + 1;
  }

  let pagerMin = Math.max(1, Math.ceil(page - maxPageList / 2));
  let pagerMax = Math.min(pagesCount, Math.floor(page + maxPageList / 2));
  if (pagerMin === 1) {
    if (MAX_PAGE_LIST < pagesCount) {
      pagerMax = MAX_PAGE_LIST;
    } else {
      pagerMax = pagesCount;
    }
  }
  if (pagerMax === pagesCount) {
    if (pagerMax - MAX_PAGE_LIST < 1) {
      pagerMin = 1;
    } else {
      pagerMin = pagerMax - MAX_PAGE_LIST;
    }
  }

  if (pagerMin > 1) {
    pager.previousDots = true;
  }

  if (pagerMax < pagesCount) {
    pager.nextDots = true;
  }

  for (let i = pagerMin; i <= pagerMax; i++) {
    pager.pages.push(i);
  }

  return pager;
}

/**
 * Shape of the result emitted by mongoose-paginate via
 * `User.findUsersWithPagination`. Re-declared here because the model layer
 * still exposes `paginate: any`; we re-narrow for this handler instead of
 * loosening the helper signature globally.
 */
interface PaginateResult {
  docs: UserDocument[];
  total: number;
  limit: number;
  page: number;
  pages: number;
}

/**
 * Promise wrapper around `User.findUsersWithPagination` (which is still
 * callback-based to match the legacy controller).
 */
const paginateUsers = (User: UserModel, options: { page: number; limit: number }, query: Record<string, unknown>): Promise<PaginateResult> =>
  new Promise((resolve, reject) => {
    User.findUsersWithPagination(options, query, (err: Error | null, result: PaginateResult) => {
      if (err) return reject(err);
      resolve(result);
    });
  });

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

const internalErrorBody = {
  error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const },
};

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
        const result = await paginateUsers(User, { page, limit }, filter);
        const pager = createPager(result.total, result.page, result.pages, MAX_PAGE_LIST);

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
        return { status: 500 as const, body: internalErrorBody };
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
        return { status: 500 as const, body: internalErrorBody };
      }
    },
  });

  createExpressEndpoints(apiContract.admin.users, usersRouter, router);
  return router;
};
