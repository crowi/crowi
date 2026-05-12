import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type InvitedUserResult } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { createPager, MAX_PAGE_LIST } from 'src/util/admin-pager';
import { internalServerErrorResponse, isValidObjectId, toUserPublic } from 'src/util/ts-rest-helpers';
import type { UserDocument, UserModel } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:users');

const ADMIN_PAGINATE_SORT = { status: 1, username: 1, createdAt: 1 } as const;
const ADMIN_PAGINATE_SELECT = '-password -apiToken -googleId -githubId';

const REGEX_META = /[-/\\^$*+?.()|[\]{}]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_META, '\\$&');

/**
 * Build the Mongo `$or` filter for the free-text search. Splits on the first
 * space so "alice bob" matches alice OR bob across username/name/email.
 * Tokens are regex-escaped so user input like '(' or '.' doesn't crash with
 * `SyntaxError` or match more than expected.
 */
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
 * Wrap a handler so any thrown error is logged with `label` and converted to a
 * 500 response. Saves a 4-line try/catch boilerplate per endpoint.
 */
const handle = async <T>(label: string, fn: () => Promise<T>): Promise<T | typeof internalServerErrorResponse> => {
  try {
    return await fn();
  } catch (err) {
    debug(`Error in ${label}:`, (err as Error).message);
    return internalServerErrorResponse;
  }
};

/**
 * Bridge a callback-style instance method (e.g. `user.makeAdmin(cb)`) so we
 * can `await` it. The model code is left in callback form to avoid touching
 * shared statics in this migration.
 */
const promisifyMethod = <T>(invoker: (cb: (err: Error | null, data: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    invoker((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

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
 * The legacy callback collapses "exists" and "save failed" into the same
 * `{ password: null, user: null }` shape; we issue one extra `$in` lookup over
 * just the null-row emails to disambiguate (no extra query on the all-success
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

const findEmailConflict = (existingByEmail: UserDocument | null, currentUser: UserDocument): typeof emailConflictResponse | null => {
  if (existingByEmail && !currentUser.equals(existingByEmail)) return emailConflictResponse;
  return null;
};

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
  return handle(errLabel, async () => {
    const user = (await User.findById(id)) as UserDocument | null;
    if (!user) return userNotFoundResponse;
    const updated = await mutate(user);
    return { status: 200 as const, body: { user: toUserPublic(updated) } };
  });
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const User = crowi.model('User');

  const usersRouter = s.router(apiContract.admin.users, {
    listUsers: async ({ query }) =>
      handle('listUsers', async () => {
        const { q, page, limit } = query;
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
      }),

    searchUsersByEmail: async ({ query }) =>
      handle('searchUsersByEmail', async () => {
        const users: UserDocument[] = await User.findUsersByPartOfEmail(query.email, {});
        return {
          status: 200 as const,
          body: { users: users.map(toUserPublic) },
        };
      }),

    inviteUsers: async ({ body }) => {
      const emailList = body.emailList.map((email) => email.trim()).filter((email) => email.length > 0);
      if (emailList.length === 0) {
        return {
          status: 400 as const,
          body: { error: { code: 'VALIDATION_ERROR' as const, message: 'emailList must contain at least one non-empty email' } },
        };
      }
      return handle('inviteUsers', async () => {
        const rows = await createUsersByInvitationAsync(User, emailList, body.sendEmail ?? false);
        const results = await toInvitedUserResults(User, rows);
        return { status: 200 as const, body: { results } };
      });
    },

    editUser: async ({ params, body }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);
      return handle('editUser', async () => {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return userNotFoundResponse;

        const conflict = findEmailConflict(duplicate, user);
        if (conflict) return conflict;

        const updated = (await user.updateNameAndEmail(body.name, body.email)) as UserDocument;
        return { status: 200 as const, body: { user: toUserPublic(updated) } };
      });
    },

    makeAdmin: ({ params }) => runSimpleUserMutation(User, params.id, 'makeAdmin', (user) => promisifyMethod((cb) => user.makeAdmin(cb))),

    removeFromAdmin: ({ params }) => runSimpleUserMutation(User, params.id, 'removeFromAdmin', (user) => promisifyMethod((cb) => user.removeFromAdmin(cb))),

    activateUser: ({ params }) => runSimpleUserMutation(User, params.id, 'activateUser', (user) => promisifyMethod((cb) => user.statusActivate(cb))),

    suspendUser: ({ params }) => runSimpleUserMutation(User, params.id, 'suspendUser', (user) => promisifyMethod((cb) => user.statusSuspend(cb))),

    resetPassword: async ({ params }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);
      return handle('resetPassword', async () => {
        const exists = (await User.findById(id)) as UserDocument | null;
        if (!exists) return userNotFoundResponse;

        const { user, newPassword } = await User.resetPasswordByRandomString(exists._id);
        return {
          status: 200 as const,
          body: { user: toUserPublic(user), newPassword },
        };
      });
    },

    updateUserEmail: async ({ params, body }) => {
      const { id } = params;
      if (!isValidObjectId(id)) return invalidUserIdResponse(id);
      return handle('updateUserEmail', async () => {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return userNotFoundResponse;

        const conflict = findEmailConflict(duplicate, user);
        if (conflict) return conflict;

        const updated = (await user.updateEmail(body.email)) as UserDocument;
        return { status: 200 as const, body: { user: toUserPublic(updated) } };
      });
    },
  });

  createExpressEndpoints(apiContract.admin.users, usersRouter, router);
  return router;
};
