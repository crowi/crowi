/**
 * Public account-activation (email confirmation) handler.
 *
 *   GET  /auth/activate?token= — validate token for the page preflight
 *   POST /auth/activate        — confirm email, activate, sign in
 *
 * The signed activation token (purpose `'activate'`, minted during
 * self-registration) is the credential, so both routes are public.
 */
import { activationRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';
import { toAuthUser } from './_helpers/user-shape';

const debug = Debug('crowi:hono:handlers:activation');

const INVALID_TOKEN_BODY = {
  error: { code: 'INVALID_ACTIVATION_TOKEN' as const, message: 'Activation token is invalid or expired' as const },
};

export const registerActivationRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);
  const mailTokenUtil = createMailTokenUtil();

  return app
    .openapi(activationRoutes.validateActivationTokenRoute, async (c) => {
      const { token } = c.req.valid('query');
      const payload = mailTokenUtil.verifyMailToken(token, 'activate');
      if (!payload) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      return c.json({ ok: true as const }, 200);
    })
    .openapi(activationRoutes.activateAccountRoute, async (c) => {
      const { token } = c.req.valid('json');

      try {
        const payload = mailTokenUtil.verifyMailToken(token, 'activate');
        if (!payload) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user) {
          return c.json({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } }, 404);
        }

        // Idempotent: a second click on a still-valid link just signs in.
        if (user.emailConfirmedAt == null) {
          user.emailConfirmedAt = new Date();
        }
        if (user.status === User.STATUS_REGISTERED) {
          user.status = User.STATUS_ACTIVE;
        }
        const saved = await user.save();

        const tokens = jwtUtil.generateTokens(saved);
        return c.json({ ...tokens, user: toAuthUser(saved) }, 200);
      } catch (error) {
        debug('activation error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
