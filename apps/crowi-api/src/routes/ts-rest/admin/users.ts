import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type InvitedUserResult } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { createPager, MAX_PAGE_LIST } from 'src/util/admin-pager';
import { internalServerErrorResponse, isValidObjectId, toUserPublic } from 'src/util/ts-rest-helpers';
import type { UserDocument, UserModel } from 'src/models/user';
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

/**
 * Standard 400 for an invalid `:id` path parameter. We surface the input back
 * in `message` so tests / logs can identify the offending request.
 */
const invalidUserIdResponse = (id: string) =>
  ({
    status: 400 as const,
    body: { error: { code: 'VALIDATION_ERROR' as const, message: `Invalid user id: ${id}` } },
  }) as const;

const userNotFoundResponse = {
  status: 404 as const,
  body: { error: { code: 'NOT_FOUND' as const, message: 'User not found' as const } },
} as const;

const emailConflictResponse = {
  status: 409 as const,
  body: { error: { code: 'CONFLICT' as const, message: 'Email is already in use by another user' as const } },
} as const;

/**
 * Wrap a callback-style instance method (e.g. `user.makeAdmin(cb)`) so we can
 * `await` it from the ts-rest handler. The underlying model methods are kept
 * in callback form to avoid touching shared model code as part of this
 * migration; this wrapper is the minimal bridge to async/await semantics.
 *
 * Generic on `T` so each call site can keep a precise return type without
 * casting through `any`.
 */
const promisifyMethod = <T>(invoker: (cb: (err: Error | null, data: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    invoker((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

/**
 * Wrap `User.createUsersByInvitation`. The model resolves its callback with
 * `(null, createdUserList)` even on individual-row failure (it surfaces the
 * failure as a `password: null` entry), so we treat any non-null `err` as a
 * top-level batch failure.
 */
type LegacyInvitedUserRow = {
  email: string;
  password: string | null;
  user: UserDocument | null;
};

const createUsersByInvitationAsync = (User: UserModel, emailList: string[], toSendEmail: boolean): Promise<LegacyInvitedUserRow[]> =>
  new Promise((resolve, reject) => {
    User.createUsersByInvitation(emailList, toSendEmail, (err: Error | null, list: LegacyInvitedUserRow[]) => {
      if (err) return reject(err);
      resolve(list);
    });
  });

/**
 * Convert legacy invitation rows into the wire-level discriminated union.
 *
 * Mapping rules (mirroring `User.createUsersByInvitation`):
 *  - `user` is set            -> 'created' (newly inserted)
 *  - `user` null + email already exists in the DB -> 'exists'
 *  - `user` null without an existing match -> 'failed' (save() rejected)
 *
 * The legacy callback collapses both "exists" and "save failed" into a
 * `{ password: null, user: null }` row; to disambiguate we issue a single
 * `$in` lookup over only the null-row emails (no extra query on the all-success
 * path).
 */
const toInvitedUserResults = async (User: UserModel, rows: LegacyInvitedUserRow[]): Promise<InvitedUserResult[]> => {
  const nullEmails = rows.filter((row) => !row.user).map((row) => row.email);
  const existingEmails = nullEmails.length === 0 ? new Set<string>() : await findExistingEmails(User, nullEmails);

  return rows.map((row) => {
    if (row.user) return { email: row.email, status: 'created' as const, userId: row.user._id.toString() };
    if (existingEmails.has(row.email)) return { email: row.email, status: 'exists' as const };
    return { email: row.email, status: 'failed' as const };
  });
};

const findExistingEmails = async (User: UserModel, emails: string[]): Promise<Set<string>> => {
  const docs = (await User.find({ email: { $in: emails } }, 'email').lean()) as { email: string }[];
  return new Set(docs.map((doc) => doc.email));
};

/**
 * Returns `emailConflictResponse` if `email` is already used by another user,
 * else null. Caller is expected to short-circuit on a non-null return.
 */
const findEmailConflict = (existingByEmail: UserDocument | null, currentUser: UserDocument): typeof emailConflictResponse | null => {
  if (existingByEmail && !currentUser.equals(existingByEmail)) return emailConflictResponse;
  return null;
};

/**
 * Shared pipeline for the four "trivial" per-user mutating endpoints
 * (makeAdmin / removeFromAdmin / activate / suspend): validate id -> load
 * user -> apply `mutate` -> return UserPublic. Errors translate to 500.
 *
 * `errLabel` is purely for the debug log so each handler can be identified
 * in mixed traces.
 */
type SimpleMutationResponse =
  | { status: 200; body: { user: ReturnType<typeof toUserPublic> } }
  | typeof userNotFoundResponse
  | typeof internalServerErrorResponse
  | ReturnType<typeof invalidUserIdResponse>;

const runSimpleUserMutation = async (
  User: UserModel,
  id: string,
  errLabel: string,
  mutate: (user: UserDocument) => Promise<UserDocument>,
): Promise<SimpleMutationResponse> => {
  if (!isValidObjectId(id)) return invalidUserIdResponse(id);
  try {
    const user = (await User.findById(id)) as UserDocument | null;
    if (!user) return userNotFoundResponse;
    const updated = await mutate(user);
    return { status: 200 as const, body: { user: toUserPublic(updated) } };
  } catch (err) {
    debug(`Error in ${errLabel}:`, (err as Error).message);
    return internalServerErrorResponse;
  }
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

    /**
     * POST /api/v2/admin/users/invite
     *
     * Bulk invitation. The contract guarantees `emailList` is non-empty
     * (Zod `.min(1)`); the handler trims whitespace and forwards to
     * `User.createUsersByInvitation`, then maps each row to the typed
     * discriminated union expected by the response schema.
     *
     * Optional `sendEmail` toggles the post-create mailer (template
     * `admin/userInvitation.txt`). The model already handles the mail
     * dispatch internally; we just pass the flag through.
     */
    inviteUsers: async ({ body }) => {
      const emailList = body.emailList.map((email) => email.trim()).filter((email) => email.length > 0);
      if (emailList.length === 0) {
        return {
          status: 400 as const,
          body: { error: { code: 'VALIDATION_ERROR' as const, message: 'emailList must contain at least one non-empty email' } },
        };
      }

      try {
        const rows = await createUsersByInvitationAsync(User, emailList, body.sendEmail ?? false);
        const results = await toInvitedUserResults(User, rows);
        return { status: 200 as const, body: { results } };
      } catch (err) {
        const error = err as Error;
        debug('Error inviting users:', error.message);
        return internalServerErrorResponse;
      }
    },

    /**
     * PATCH /api/v2/admin/users/:id
     *
     * Update both name and email. Email collisions with another user surface
     * as 409 Conflict (the legacy endpoint returned `ApiResponse.error` at
     * HTTP 200 with `{ ok: false }`); the new contract corrects this to a
     * proper HTTP-level conflict.
     */
    editUser: async ({ params, body }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);

      try {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return userNotFoundResponse;

        const conflict = findEmailConflict(duplicate, user);
        if (conflict) return conflict;

        const updated = (await user.updateNameAndEmail(body.name, body.email)) as UserDocument;
        return { status: 200 as const, body: { user: toUserPublic(updated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error editing user:', error.message);
        return internalServerErrorResponse;
      }
    },

    /**
     * PUT /api/v2/admin/users/:id/admin — grant admin permission.
     */
    makeAdmin: ({ params }) => runSimpleUserMutation(User, params.id, 'makeAdmin', (user) => promisifyMethod((cb) => user.makeAdmin(cb))),

    /**
     * DELETE /api/v2/admin/users/:id/admin — revoke admin permission.
     *
     * The legacy endpoint had no self-demote guard; preserved here. Adding a
     * guard is tracked in the task openQuestions.
     */
    removeFromAdmin: ({ params }) => runSimpleUserMutation(User, params.id, 'removeFromAdmin', (user) => promisifyMethod((cb) => user.removeFromAdmin(cb))),

    /**
     * PUT /api/v2/admin/users/:id/status/active — activate the user.
     *
     * `statusActivate` emits the `userEvent` 'activated' side-effect that
     * `events/user.ts` listeners react to; preserved for parity.
     */
    activateUser: ({ params }) => runSimpleUserMutation(User, params.id, 'activateUser', (user) => promisifyMethod((cb) => user.statusActivate(cb))),

    /**
     * PUT /api/v2/admin/users/:id/status/suspended — suspend the user.
     *
     * `statusSuspend` also fills in blank email/name/username placeholders on
     * legacy records as a side-effect; preserved for parity.
     */
    suspendUser: ({ params }) => runSimpleUserMutation(User, params.id, 'suspendUser', (user) => promisifyMethod((cb) => user.statusSuspend(cb))),

    /**
     * POST /api/v2/admin/users/:id/reset-password
     *
     * Returns the generated plaintext password alongside the updated user.
     * The plaintext disclosure preserves parity with the legacy admin UI;
     * switching to email-delivered reset is tracked in openQuestions.
     */
    resetPassword: async ({ params }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);

      try {
        // Pre-flight check so a missing user surfaces as 404 instead of bubbling
        // up the model's generic "User not found" Error to the 500 catch.
        const exists = (await User.findById(id)) as UserDocument | null;
        if (!exists) return userNotFoundResponse;

        const { user, newPassword } = await User.resetPasswordByRandomString(exists._id);
        return {
          status: 200 as const,
          body: { user: toUserPublic(user), newPassword },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error resetting password:', error.message);
        return internalServerErrorResponse;
      }
    },

    /**
     * PUT /api/v2/admin/users/:id/email
     *
     * Email-only update with the same 409-on-collision semantics as the full
     * edit endpoint.
     */
    updateUserEmail: async ({ params, body }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);

      try {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return userNotFoundResponse;

        const conflict = findEmailConflict(duplicate, user);
        if (conflict) return conflict;

        const updated = (await user.updateEmail(body.email)) as UserDocument;
        return { status: 200 as const, body: { user: toUserPublic(updated) } };
      } catch (err) {
        const error = err as Error;
        debug('Error updating email:', error.message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.admin.users, usersRouter, router);
  return router;
};
