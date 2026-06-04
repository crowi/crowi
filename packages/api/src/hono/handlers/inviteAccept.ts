/**
 * Public invite-acceptance handler.
 *
 *   GET  /invite/accept?token= — preview (returns the invited email)
 *   POST /invite/accept        — set username/name/password, activate,
 *                                and return login tokens
 *
 * The signed invite token (purpose `'invite'`, minted in
 * `User.createUsersByInvitation`) is the credential, so both routes are
 * public. Single-use is enforced by status: a token whose user is no
 * longer STATUS_INVITED (already accepted) is rejected.
 */
import { inviteAcceptRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';
import { mapDuplicateKeyError } from 'src/util/map-duplicate-key-error';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';
import { toAuthUser } from './_helpers/user-shape';

const debug = Debug('crowi:hono:handlers:inviteAccept');

const INVALID_TOKEN_BODY = {
  error: { code: 'INVALID_INVITE_TOKEN' as const, message: 'Invite token is invalid or expired' as const },
};
const ALREADY_ACCEPTED_BODY = {
  error: { code: 'INVITE_ALREADY_ACCEPTED' as const, message: 'This invite has already been accepted' as const },
};

export const registerInviteAcceptRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);
  const mailTokenUtil = createMailTokenUtil();

  return app
    .openapi(inviteAcceptRoutes.invitePreviewRoute, async (c) => {
      const { token } = c.req.valid('query');
      const payload = mailTokenUtil.verifyMailToken(token, 'invite');
      if (!payload) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      const user = await User.findById(payload.userId);
      if (!user || user.status !== User.STATUS_INVITED) {
        return c.json(ALREADY_ACCEPTED_BODY, 409);
      }
      return c.json({ email: payload.email }, 200);
    })
    .openapi(inviteAcceptRoutes.acceptInviteRoute, async (c) => {
      const { token, username, name, password } = c.req.valid('json');

      try {
        const payload = mailTokenUtil.verifyMailToken(token, 'invite');
        if (!payload) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user) {
          return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'Invited user no longer exists' } }, 404);
        }
        if (user.status !== User.STATUS_INVITED) {
          return c.json(ALREADY_ACCEPTED_BODY, 409);
        }

        // Username uniqueness (excluding this invited user).
        const clash = await User.findOne({ username });
        if (clash && clash._id.toString() !== user._id.toString()) {
          return c.json({ error: { code: 'USERNAME_TAKEN' as const, message: 'Username already taken' } }, 409);
        }

        const activated = await new Promise<UserDocument>((resolve, reject) => {
          user.activateInvitedUser(username, name, password, (err: Error | null, userData: UserDocument) => {
            if (err) reject(err);
            else resolve(userData);
          });
        });

        const tokens = jwtUtil.generateTokens(activated);
        return c.json({ ...tokens, user: toAuthUser(activated) }, 200);
      } catch (error) {
        // The username findOne pre-check can be raced; the unique index is the
        // final defence. Map its E11000 to the same 409 the pre-check returns.
        const duplicateCode = mapDuplicateKeyError(error);
        if (duplicateCode) {
          const message = duplicateCode === 'USERNAME_TAKEN' ? 'Username already taken' : 'That email address is already in use';
          return c.json({ error: { code: duplicateCode, message } }, 409);
        }
        debug('Invite acceptance error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
