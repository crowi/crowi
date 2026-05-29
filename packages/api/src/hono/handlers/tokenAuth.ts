/**
 * RFC-0006 Phase 4 Batch 1 — `tokenAuth` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/tokenAuth.ts` +
 * `packages/api/src/controllers/tokenAuth.ts` (the latter only had
 * controller objects bound to Express `req`/`res`; that indirection is
 * collapsed here — handlers read `c.req.valid('json')` and call into the
 * `User` model + `createJwtUtil(crowi)` directly).
 *
 * Five endpoints, in order:
 *
 *   POST /auth/login    — public, refuses with 503 until installed
 *   POST /auth/register — public, refuses with 503 until installed
 *   POST /auth/refresh  — public
 *   POST /auth/logout   — requires JWT (middleware applied per-path)
 *   GET  /auth/me       — requires JWT (middleware applied per-path)
 *
 * Wire-format parity with the ts-rest era is preserved for every code
 * path (status codes, error envelopes, success payload shape) with one
 * documented drift: the legacy refresh endpoint returned
 * `INVALID_REFRESH_TOKEN` for verify failure; the new envelope is
 * `AuthenticationRequiredErrorSchema` (literal `AUTHENTICATION_REQUIRED`
 * / `'Authentication is required'`). The schema only allows that
 * literal, so the rename is intentional and clients refreshing tokens
 * now branch on `response.status === 401` instead of the inner code.
 */
import { tokenLoginRoute, tokenLogoutRoute, tokenMeRoute, tokenRefreshRoute, tokenRegisterRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';

import { AUTH_REQUIRED_BODY, INTERNAL_ERROR_BODY } from './_helpers/errors';
import { toAuthUser } from './_helpers/user-shape';
import { isAppInstalled } from './installer';

const debug = Debug('crowi:hono:handlers:tokenAuth');

const INVALID_CREDENTIALS_BODY = {
  error: { code: 'INVALID_CREDENTIALS' as const, message: 'Invalid email or password' as const },
};

const APP_NOT_INSTALLED_BODY = {
  error: {
    code: 'APPLICATION_NOT_INSTALLED' as const,
    message: 'Application is not installed' as const,
    redirectTo: '/installer' as const,
  },
};

export const registerTokenAuthRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const Config = crowi.model('Config');
  const jwtUtil = createJwtUtil(crowi);

  // Per-path JWT middleware. `/auth/login`, `/auth/register` and
  // `/auth/refresh` must stay public; `/auth/logout` and `/auth/me`
  // require an active access token. Installed before `.openapi(...)`
  // so the middleware sees the matching route — Hono evaluates `use`
  // entries against the request path independently of how the
  // subsequent route handlers chain into `app`.
  const jwtAuth = createJwtAuth(crowi);
  app.use('/auth/logout', jwtAuth);
  app.use('/auth/me', jwtAuth);

  return app
    .openapi(tokenLoginRoute, async (c) => {
      const { email, password } = c.req.valid('json');
      debug('Login attempt for email:', email);

      try {
        if (!(await isAppInstalled(Config))) {
          return c.json(APP_NOT_INSTALLED_BODY, 503);
        }

        const foundUser = await User.findUserByEmail(email);
        if (!foundUser) {
          return c.json(INVALID_CREDENTIALS_BODY, 401);
        }

        const user = await foundUser.populateSecrets();
        if (!user) {
          return c.json(INVALID_CREDENTIALS_BODY, 401);
        }

        if (user.status !== User.STATUS_ACTIVE) {
          let code = 'USER_NOT_ACTIVE';
          let message = 'User account is not active';
          if (user.status === User.STATUS_REGISTERED) {
            if (user.emailConfirmedAt == null) {
              // Self-registered, awaiting email confirmation.
              code = 'EMAIL_NOT_CONFIRMED';
              message = 'Please confirm your email address — check your inbox for the activation link.';
            } else {
              code = 'USER_REGISTERED';
              message = 'User registration is not complete';
            }
          } else if (user.status === User.STATUS_SUSPENDED) {
            code = 'USER_SUSPENDED';
            message = 'User account is suspended';
          } else if (user.status === User.STATUS_INVITED) {
            code = 'USER_INVITED';
            message = 'User invitation is pending';
          }
          return c.json({ error: { code, message } }, 403);
        }

        const isPasswordValid = await user.isPasswordValid(password);
        if (!isPasswordValid) {
          return c.json(INVALID_CREDENTIALS_BODY, 401);
        }

        const tokens = jwtUtil.generateTokens(user);
        return c.json({ ...tokens, user: toAuthUser(user) }, 200);
      } catch (error) {
        debug('Login error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(tokenRegisterRoute, async (c) => {
      const { username, name, email, password } = c.req.valid('json');

      try {
        if (!(await isAppInstalled(Config))) {
          return c.json(APP_NOT_INSTALLED_BODY, 503);
        }

        const config = (await Config.loadAllConfig()) as { crowi: Record<string, unknown> };
        if (config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_CLOSED) {
          return c.json({ error: { code: 'REGISTRATION_CLOSED', message: 'User registration is closed' } }, 403);
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
          const message = existingUser.email === email ? 'Email already registered' : 'Username already taken';
          return c.json({ error: { code: 'USER_EXISTS', message } }, 409);
        }

        const newUser = await new Promise<UserDocument | null>((resolve, reject) => {
          User.createUserByEmailAndPassword(name, username, email, password, 'en', (err: Error | null, user: UserDocument | null) => {
            if (err) reject(err);
            else resolve(user);
          });
        });

        if (!newUser) {
          return c.json({ error: { code: 'REGISTRATION_FAILED', message: 'Failed to create user' } }, 400);
        }

        // Self-registration no longer auto-signs-in. A would-be-active
        // account (open registration) must confirm its email first; a
        // restricted-mode account stays REGISTERED awaiting admin approval.
        if (newUser.status === User.STATUS_ACTIVE) {
          newUser.status = User.STATUS_REGISTERED;
          newUser.emailConfirmedAt = null;
          await newUser.save();

          const baseUrl = crowi.getBaseUrl() || String(config.crowi['app:url'] ?? '');
          const { token } = createMailTokenUtil().signMailToken({ purpose: 'activate', userId: newUser._id.toString(), email });
          const activationUrl = `${baseUrl}/activate?token=${token}`;
          await crowi
            .getMailer()
            .send({
              to: email,
              htmlTemplate: 'activation',
              lang: newUser.lang,
              vars: {
                activationUrl,
                appTitle: String(config.crowi['app:title'] ?? ''),
                appUrl: baseUrl,
                logoUrl: baseUrl ? `${baseUrl}/logo/500w.png` : '',
              },
            })
            // A send failure must not fail the registration — the account
            // exists and the user can request a fresh activation link.
            .catch((err) => debug('failed to send activation email:', err));

          return c.json({ status: 'confirmation_required' as const }, 200);
        }

        return c.json({ status: 'approval_required' as const }, 200);
      } catch (error) {
        debug('Registration error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(tokenRefreshRoute, async (c) => {
      const { refreshToken } = c.req.valid('json');

      if (!refreshToken) {
        return c.json({ error: { code: 'REFRESH_TOKEN_REQUIRED', message: 'Refresh token is required' } }, 400);
      }

      try {
        const payload = jwtUtil.verifyToken(refreshToken, 'refresh');
        if (!payload) {
          return c.json(AUTH_REQUIRED_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user || user.status !== User.STATUS_ACTIVE) {
          return c.json(AUTH_REQUIRED_BODY, 401);
        }

        const tokens = jwtUtil.generateTokens(user);
        return c.json({ ...tokens, user: toAuthUser(user) }, 200);
      } catch (error) {
        debug('Token refresh error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(tokenLogoutRoute, async (c) => {
      // Stateless JWT — logout is handled client-side (the client
      // discards the tokens). The middleware already enforced auth, so
      // we just need to ACK.
      return c.json({ message: 'Logged out successfully' }, 200);
    })
    .openapi(tokenMeRoute, async (c) => {
      const user = c.get('user');
      return c.json(
        {
          user: {
            ...toAuthUser(user),
            status: user.status,
            createdAt: user.createdAt.toISOString(),
          },
        },
        200,
      );
    });
};
