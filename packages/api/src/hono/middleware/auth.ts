/**
 * Hono port of the Express `jwtAuth` middleware. Wire-format identical to
 * `packages/api/src/middlewares/jwtAuth.ts`:
 *
 *   - Bearer token first, `crowi.accessToken` cookie fallback (for
 *     `<img src="/api/v2/...">`-style requests that cannot carry an
 *     Authorization header).
 *   - 401 `AUTHENTICATION_REQUIRED` on missing / invalid / expired token
 *     or unknown user. Body shape matches `AuthenticationRequiredErrorSchema`.
 *   - 403 `USER_REGISTERED` / `USER_SUSPENDED` / `USER_INVITED` for
 *     non-active accounts. Body shape matches `UserStatusErrorSchema`.
 *   - On success, the resolved `UserDocument` is exposed via `c.get('user')`.
 */
import type { AuthenticationRequiredErrorSchema, Scope, UserStatusErrorSchema } from '@crowi/api-contract';
import { ALL_SCOPES, parseScopeClaim } from '@crowi/api-contract';
import Debug from 'debug';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';

import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;
type UserStatusError = z.infer<typeof UserStatusErrorSchema>;

const ACCESS_TOKEN_COOKIE_NAME = 'crowi.accessToken';

export const AUTH_REQUIRED_BODY: AuthenticationRequiredError = {
  error: {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required',
  },
};

/**
 * RFC-0010 — context describing how the request authenticated.
 *
 *  - `web`: a browser session JWT (`type: 'access'`) or its cookie
 *    fallback. Carries no scope claim and is granted **all** scopes, so
 *    `requireScope` always passes and the existing UI behaviour is
 *    unchanged.
 *  - `oauth`: an OAuth access token (`type: 'oauth_access'`). Scopes are
 *    limited to the token's `scope` claim and `clientId` identifies the
 *    issuing client.
 */
export type AuthContext = { kind: 'web' } | { kind: 'oauth'; clientId: string };

export interface HonoAuthVariables {
  user: UserDocument;
  /** Scopes the authenticated principal holds (web sessions = all). */
  authScopes: ReadonlySet<Scope>;
  /** How the request authenticated; lets handlers branch web vs. OAuth. */
  authContext: AuthContext;
}

export const createJwtAuth = (crowi: Crowi) => {
  const debug = Debug('crowi:hono:middleware:auth');
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  return createMiddleware<{ Variables: HonoAuthVariables }>(async (c, next) => {
    const authHeader = c.req.header('authorization');
    let token = jwtUtil.extractTokenFromHeader(authHeader);

    // The cookie fallback (for `<img src>`-style requests that cannot
    // carry an Authorization header) only ever holds a web-session
    // access token, so it is never treated as OAuth — fromCookie flips
    // the accepted token types below to `access`-only.
    let fromCookie = false;
    if (!token) {
      const cookieToken = getCookie(c, ACCESS_TOKEN_COOKIE_NAME);
      if (cookieToken) {
        token = cookieToken.trim() || null;
        fromCookie = !!token;
      }
    }

    if (!token) {
      return c.json(AUTH_REQUIRED_BODY, 401);
    }

    // Bearer: accept both web-session (`access`) and OAuth
    // (`oauth_access`) tokens. PAT (`crowi_pat_` opaque tokens) land in
    // Phase 2. Cookie: web-session only.
    const payload = fromCookie ? jwtUtil.verifyToken(token, 'access') : jwtUtil.verifyToken(token, ['access', 'oauth_access'] as const);
    if (!payload) {
      return c.json(AUTH_REQUIRED_BODY, 401);
    }

    try {
      const user = await User.findById(payload.userId);
      if (!user) {
        return c.json(AUTH_REQUIRED_BODY, 401);
      }

      if (user.status !== User.STATUS_ACTIVE) {
        let code: 'USER_REGISTERED' | 'USER_SUSPENDED' | 'USER_INVITED' = 'USER_SUSPENDED';
        let message = 'User account is not active';
        let redirectTo = '/login/error/suspended';

        if (user.status === User.STATUS_REGISTERED) {
          code = 'USER_REGISTERED';
          message = 'User registration is not complete';
          redirectTo = '/login/error/registered';
        } else if (user.status === User.STATUS_SUSPENDED) {
          code = 'USER_SUSPENDED';
          message = 'User account is suspended';
          redirectTo = '/login/error/suspended';
        } else if (user.status === User.STATUS_INVITED) {
          code = 'USER_INVITED';
          message = 'User invitation is pending';
          redirectTo = '/login/invited';
        }

        const body: UserStatusError = {
          error: { code, message, redirectTo },
        };
        return c.json(body, 403);
      }

      c.set('user', user as UserDocument);

      // RFC-0010 scope resolution. Web sessions (`access`, or the cookie
      // fallback) get every scope so `requireScope` always passes and UI
      // behaviour is unchanged. OAuth tokens are limited to their parsed
      // `scope` claim.
      if (payload.type === 'oauth_access') {
        c.set('authScopes', parseScopeClaim(payload.scope));
        c.set('authContext', { kind: 'oauth', clientId: payload.client_id });
      } else {
        c.set('authScopes', ALL_SCOPES);
        c.set('authContext', { kind: 'web' });
      }

      await next();
    } catch (error) {
      debug('JWT authentication error:', error);
      return c.json(AUTH_REQUIRED_BODY, 401);
    }
  });
};
