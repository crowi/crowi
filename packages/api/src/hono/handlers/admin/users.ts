/**
 * RFC-0006 Phase 4 Batch 9 — `admin.users` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/users.ts`. 10 admin-only
 * endpoints — see the contract header for the full list.
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/users/*` + the bare `/admin/users` path.
 *
 * Logic parity:
 *   - Same `buildSearchFilter` regex-escape semantics as the legacy ts-rest
 *     era. Per-email `inviteUsers` row disambiguation (created / exists /
 *     failed) uses the same `$in` follow-up over null-row emails.
 */
import { type InvitedUserResult, adminUsersRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { UserDocument, UserModel } from 'src/models/user';
import { MAX_PAGE_LIST, createPager } from 'src/util/admin-pager';
import { isValidObjectId, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:users');

const ADMIN_PAGINATE_SORT = { status: 1, username: 1, createdAt: 1 } as const;
const ADMIN_PAGINATE_SELECT = '-password -googleId -githubId';
const REGEX_META = /[-/\\^$*+?.()|[\]{}]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_META, '\\$&');

const buildSearchFilter = (q: string | undefined): { $or?: Record<string, { $regex: string; $options: string }>[] } => {
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
};

const invalidIdBody = (id: string) => ({
  error: { code: 'VALIDATION_ERROR' as const, message: `Invalid user id: ${id}` },
});
const userNotFoundBody = { error: { code: 'NOT_FOUND' as const, message: 'User not found' as const } } as const;
const emailConflictBody = { error: { code: 'CONFLICT' as const, message: 'Email is already in use by another user' as const } } as const;

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

const promisifyMethod = <T>(invoker: (cb: (err: Error | null, data: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    invoker((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const findExistingEmails = async (User: UserModel, emails: string[]): Promise<Set<string>> => {
  const docs = (await User.find({ email: { $in: emails } }, 'email').lean()) as { email: string }[];
  return new Set(docs.map((doc) => doc.email));
};

const toInvitedUserResults = async (User: UserModel, rows: LegacyInvitedUserRow[]): Promise<InvitedUserResult[]> => {
  const nullEmails = rows.filter((row) => !row.user).map((row) => row.email);
  const existingEmails = nullEmails.length === 0 ? new Set<string>() : await findExistingEmails(User, nullEmails);

  return rows.map((row) => {
    if (row.user) return { email: row.email, status: 'created' as const, userId: row.user._id.toString() };
    if (existingEmails.has(row.email)) return { email: row.email, status: 'exists' as const };
    return { email: row.email, status: 'failed' as const };
  });
};

export const registerAdminUsersRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');

  app.use('/admin/users/*', createJwtAdminRequired(crowi));
  app.use('/admin/users', createJwtAdminRequired(crowi));

  return app
    .openapi(adminUsersRoutes.listUsersRoute, async (c) => {
      try {
        const { q, page, limit } = c.req.valid('query');
        const filter = buildSearchFilter(q);
        const result = await User.paginate(filter, {
          page,
          limit,
          sort: ADMIN_PAGINATE_SORT,
          select: ADMIN_PAGINATE_SELECT,
        });
        const pager = createPager(result.total, result.page ?? page, result.pages, MAX_PAGE_LIST);
        return c.json(
          {
            users: result.docs.map(toUserPublic),
            pager,
          },
          200,
        );
      } catch (err) {
        debug('listUsers error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.searchUsersByEmailRoute, async (c) => {
      try {
        const { email } = c.req.valid('query');
        const users: UserDocument[] = await User.findUsersByPartOfEmail(email, {});
        return c.json({ users: users.map(toUserPublic) }, 200);
      } catch (err) {
        debug('searchUsersByEmail error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.inviteUsersRoute, async (c) => {
      const body = c.req.valid('json');
      const emailList = body.emailList.map((email: string) => email.trim()).filter((email: string) => email.length > 0);
      if (emailList.length === 0) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR' as const,
              message: 'emailList must contain at least one non-empty email',
            },
          },
          400,
        );
      }
      try {
        const rows = await createUsersByInvitationAsync(User, emailList, body.sendEmail ?? false);
        const results = await toInvitedUserResults(User, rows);
        return c.json({ results }, 200);
      } catch (err) {
        debug('inviteUsers error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.editUserRoute, async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);

      try {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return c.json(userNotFoundBody, 404);
        if (duplicate && !user.equals(duplicate)) return c.json(emailConflictBody, 409);

        const updated = (await user.updateNameAndEmail(body.name, body.email)) as UserDocument;
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('editUser error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.makeAdminRoute, async (c) => {
      const { id } = c.req.valid('param');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const user = (await User.findById(id)) as UserDocument | null;
        if (!user) return c.json(userNotFoundBody, 404);
        const updated = await promisifyMethod<UserDocument>((cb) => user.makeAdmin(cb));
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('makeAdmin error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.removeFromAdminRoute, async (c) => {
      const { id } = c.req.valid('param');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const user = (await User.findById(id)) as UserDocument | null;
        if (!user) return c.json(userNotFoundBody, 404);
        const updated = await promisifyMethod<UserDocument>((cb) => user.removeFromAdmin(cb));
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('removeFromAdmin error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.activateUserRoute, async (c) => {
      const { id } = c.req.valid('param');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const user = (await User.findById(id)) as UserDocument | null;
        if (!user) return c.json(userNotFoundBody, 404);
        const updated = await promisifyMethod<UserDocument>((cb) => user.statusActivate(cb));
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('activateUser error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.suspendUserRoute, async (c) => {
      const { id } = c.req.valid('param');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const user = (await User.findById(id)) as UserDocument | null;
        if (!user) return c.json(userNotFoundBody, 404);
        const updated = await promisifyMethod<UserDocument>((cb) => user.statusSuspend(cb));
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('suspendUser error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.resetPasswordRoute, async (c) => {
      const { id } = c.req.valid('param');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const exists = (await User.findById(id)) as UserDocument | null;
        if (!exists) return c.json(userNotFoundBody, 404);
        const { user, newPassword } = await User.resetPasswordByRandomString(exists._id);
        return c.json({ user: toUserPublic(user), newPassword }, 200);
      } catch (err) {
        debug('resetPassword error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminUsersRoutes.updateUserEmailRoute, async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      if (!isValidObjectId(id)) return c.json(invalidIdBody(id), 400);
      try {
        const [user, duplicate] = (await Promise.all([User.findById(id).exec(), User.findUserByEmail(body.email)])) as [
          UserDocument | null,
          UserDocument | null,
        ];
        if (!user) return c.json(userNotFoundBody, 404);
        if (duplicate && !user.equals(duplicate)) return c.json(emailConflictBody, 409);
        const updated = (await user.updateEmail(body.email)) as UserDocument;
        return c.json({ user: toUserPublic(updated) }, 200);
      } catch (err) {
        debug('updateUserEmail error: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
