/**
 * Public email-change confirmation handler.
 *
 *   GET  /auth/confirm-email-change?token= — preflight (token valid?)
 *   POST /auth/confirm-email-change        — apply the new email address
 *
 * The user requests the change via `PUT /me` (which does not apply it);
 * the signed token (purpose `'email-change'`, payload `email` = new
 * address) is the credential here, so both routes are public.
 */
import { emailChangeRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { createMailTokenUtil } from 'src/util/mail-token';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:emailChange');

const INVALID_TOKEN_BODY = {
  error: { code: 'INVALID_EMAIL_CHANGE_TOKEN' as const, message: 'Email-change link is invalid or expired' as const },
};

export const registerEmailChangeRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const mailTokenUtil = createMailTokenUtil();

  return app
    .openapi(emailChangeRoutes.validateEmailChangeTokenRoute, async (c) => {
      const { token } = c.req.valid('query');
      const payload = mailTokenUtil.verifyMailToken(token, 'email-change');
      if (!payload) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      return c.json({ ok: true as const, email: payload.email }, 200);
    })
    .openapi(emailChangeRoutes.confirmEmailChangeRoute, async (c) => {
      const { token } = c.req.valid('json');

      try {
        const payload = mailTokenUtil.verifyMailToken(token, 'email-change');
        if (!payload) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user) {
          return c.json({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } }, 404);
        }

        // Single-use binding: the token carries the account's email at
        // issue time. If the address has since changed (already confirmed
        // once, or a newer request was made), this token is stale —
        // reject it so an old link cannot revert the address.
        if (payload.fromEmail && payload.fromEmail !== user.email) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        // The new address may have been claimed by someone else between
        // the request and the confirmation.
        const clash = await User.findOne({ email: payload.email });
        if (clash && clash._id.toString() !== user._id.toString()) {
          return c.json({ error: { code: 'EMAIL_TAKEN', message: 'That email address is already in use' } }, 409);
        }

        user.email = payload.email;
        await user.save();

        return c.json({ ok: true as const, email: user.email }, 200);
      } catch (error) {
        debug('email-change confirmation error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
