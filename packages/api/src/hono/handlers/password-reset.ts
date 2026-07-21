/**
 * Public self-service password-reset handler.
 *
 *   POST /auth/forgot-password — email a reset link (always 200)
 *   GET  /auth/reset-password?token= — validate token for the page
 *   POST /auth/reset-password  — set a new password; sign the user in
 *
 * The signed reset token (purpose `'reset'`) is the credential, so all
 * routes are public.
 */
import { passwordResetRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';
import { toAuthUser } from './_helpers/user-shape';

const debug = Debug('crowi:hono:handlers:passwordReset');

const INVALID_TOKEN_BODY = {
  error: { code: 'INVALID_RESET_TOKEN' as const, message: 'Reset token is invalid or expired' as const },
};

export const registerPasswordResetRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);
  const mailTokenUtil = createMailTokenUtil();

  return app
    .openapi(passwordResetRoutes.forgotPasswordRoute, async (c) => {
      const { email } = c.req.valid('json');

      try {
        const user = await User.findOne({ email });
        // Only active accounts can self-reset. We always return 200
        // regardless (anti-enumeration): the caller cannot tell whether
        // the email maps to an account.
        if (user && user.status === User.STATUS_ACTIVE) {
          const mailer = crowi.getMailer();
          const { token } = mailTokenUtil.signMailToken({ purpose: 'reset', userId: user._id.toString(), email });
          const baseUrl = crowi.getBaseUrl() || '';
          const resetUrl = `${baseUrl}/reset-password?token=${token}`;

          // Fire-and-forget: do NOT await. Awaiting only on the
          // account-exists branch would make it slower than the
          // unknown-email branch, leaking a timing side-channel that
          // defeats the always-200 anti-enumeration response.
          void mailer
            .send({ to: email, htmlTemplate: 'passwordReset', lang: user.lang, vars: { ...mailer.brandVars(), resetUrl } })
            .catch((err) => debug('failed to send password-reset email:', err));
        }

        return c.json({ ok: true as const }, 200);
      } catch (error) {
        debug('forgot-password error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(passwordResetRoutes.validateResetTokenRoute, async (c) => {
      const { token } = c.req.valid('query');
      const payload = mailTokenUtil.verifyMailToken(token, 'reset');
      if (!payload) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      return c.json({ ok: true as const }, 200);
    })
    .openapi(passwordResetRoutes.selfResetPasswordRoute, async (c) => {
      const { token, password } = c.req.valid('json');

      try {
        const payload = mailTokenUtil.verifyMailToken(token, 'reset');
        if (!payload) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user) {
          return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'User no longer exists' } }, 404);
        }
        // Re-check status at consume time: the account may have been
        // suspended after the link was minted. login enforces this gate,
        // so the reset endpoint (which also signs the user in) must too.
        if (user.status !== User.STATUS_ACTIVE) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        user.setPassword(password);
        const saved = await user.save();

        // Security notification — best-effort, never blocks/fails the reset.
        void crowi
          .getMailer()
          .sendPasswordChangedNotice(saved.email, saved.lang)
          .catch((err) => debug('failed to send password-changed notice:', err));

        const tokens = jwtUtil.generateTokens(saved);
        return c.json({ ...tokens, user: toAuthUser(saved) }, 200);
      } catch (error) {
        debug('reset-password error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
