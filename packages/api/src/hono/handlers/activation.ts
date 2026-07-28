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
import type { UserDocument } from 'src/models/user';
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
          return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'User no longer exists' } }, 404);
        }

        // An activation link is an email-confirmation credential, NOT a
        // login credential. It is only good for the REGISTERED → ACTIVE
        // transition it was minted for; once the account has left that
        // state the link stops being honoured, even though its signature
        // stays valid for the rest of its 24h TTL.
        //
        // This used to fall through to `save()` + `generateTokens()` in the
        // name of idempotency ("a second click just signs in"), which meant
        // a 24h-old mail link minted a full session for an already-ACTIVE
        // account with no password and no second factor — a first-factor
        // bypass for anyone who reached the inbox, the mail transport, or a
        // forwarded copy of the URL. Deliberate behaviour change: a second
        // click now lands on the "link no longer valid" screen, whose only
        // affordance is to sign in normally.
        if (user.status !== User.STATUS_REGISTERED) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        if (user.emailConfirmedAt == null) {
          user.emailConfirmedAt = new Date();
        }

        // Becoming ACTIVE must go through statusActivate so the 'activated'
        // event fires and the user's wiki page is created at confirmation
        // time (the same hook admin approval uses). A plain save() would
        // skip it, leaving confirmed users without a user page.
        const saved: UserDocument = await new Promise<UserDocument>((resolve, reject) => {
          user.statusActivate((err: Error | null, userData: UserDocument) => (err ? reject(err) : resolve(userData)));
        });

        const tokens = jwtUtil.generateTokens(saved);
        return c.json({ ...tokens, user: toAuthUser(saved) }, 200);
      } catch (error) {
        debug('activation error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
