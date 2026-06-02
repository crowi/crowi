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
import type { ErrorCode } from '@crowi/api-contract';
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
          let code: ErrorCode = 'USER_NOT_ACTIVE';
          let message = 'User account is not active';
          if (user.status === User.STATUS_REGISTERED) {
            // REGISTERED covers two distinct gates. In restricted mode the
            // account awaits admin approval (no activation email was
            // sent); otherwise (open mode) it awaits email confirmation.
            const mode = crowi.getConfig()?.crowi?.['security:registrationMode'];
            const awaitingApproval = mode === Config.SECURITY_REGISTRATION_MODE_RESTRICTED;
            if (!awaitingApproval && user.emailConfirmedAt == null) {
              code = 'EMAIL_NOT_CONFIRMED';
              message = 'Please confirm your email address — check your inbox for the activation link.';
            } else {
              code = 'USER_REGISTERED';
              message = 'Your account is awaiting administrator approval.';
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
          return c.json({ error: { code: 'REGISTRATION_CLOSED' as const, message: 'User registration is closed' } }, 403);
        }

        // Email whitelist gate (legacy parity). Applied in every non-closed
        // mode: when `security:registrationWhiteList` is non-empty, only
        // matching addresses may register. `isEmailValid` returns true when
        // the whitelist is empty (no restriction).
        if (!User.isEmailValid(email)) {
          return c.json({ error: { code: 'EMAIL_NOT_ALLOWED' as const, message: 'This email address is not allowed to register' } }, 403);
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
          const message = existingUser.email === email ? 'Email already registered' : 'Username already taken';
          return c.json({ error: { code: 'USER_EXISTS' as const, message } }, 409);
        }

        // Create the account directly as REGISTERED. We intentionally do
        // NOT go through createUserByEmailAndPassword: in open mode it
        // would create a STATUS_ACTIVE user and emit 'activated' (which
        // creates the user's wiki page) BEFORE the email is confirmed,
        // leaving orphan pages for never-confirmed signups. The account
        // only becomes ACTIVE (and fires 'activated') on confirmation
        // (open: POST /auth/activate) or admin approval (restricted).
        const newUser = new User();
        newUser.name = name;
        newUser.username = username;
        newUser.email = email;
        newUser.setPassword(password);
        newUser.lang = 'en';
        newUser.status = User.STATUS_REGISTERED;
        newUser.emailConfirmedAt = null;
        await newUser.save();

        const mailer = crowi.getMailer();
        const brand = mailer.brandVars();
        const baseUrl = crowi.getBaseUrl() || '';
        const restricted = config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_RESTRICTED;

        if (restricted) {
          // Awaiting admin approval. Notify every active admin (best-effort,
          // per recipient language). Fire-and-forget: don't block the
          // response on the admin fan-out.
          const admins = (await User.find({ admin: true, status: User.STATUS_ACTIVE })) as UserDocument[];
          void Promise.all(
            admins.map((admin) =>
              mailer
                .send({
                  to: admin.email,
                  htmlTemplate: 'adminApprovalPending',
                  lang: admin.lang,
                  vars: { ...brand, createdUserName: newUser.name, createdUserEmail: email, adminUsersUrl: `${baseUrl}/admin/users` },
                })
                .catch((err) => debug('failed to send admin approval-pending notice:', err)),
            ),
          ).catch(() => undefined);

          return c.json({ status: 'approval_required' as const }, 200);
        }

        // Open mode: send an email-confirmation link. Fire-and-forget.
        const { token } = createMailTokenUtil().signMailToken({ purpose: 'activate', userId: newUser._id.toString(), email });
        const activationUrl = `${baseUrl}/activate?token=${token}`;
        void mailer
          .send({ to: email, htmlTemplate: 'activation', lang: newUser.lang, vars: { ...brand, activationUrl } })
          .catch((err) => debug('failed to send activation email:', err));

        return c.json({ status: 'confirmation_required' as const }, 200);
      } catch (error) {
        debug('Registration error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(tokenRefreshRoute, async (c) => {
      const { refreshToken } = c.req.valid('json');

      if (!refreshToken) {
        return c.json({ error: { code: 'REFRESH_TOKEN_REQUIRED' as const, message: 'Refresh token is required' } }, 400);
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
