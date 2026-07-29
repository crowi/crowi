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
import { ALL_SCOPES, isScope, parseScopeClaim } from '@crowi/api-contract';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';

import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil, isCurrentAuthVersion } from 'src/util/jwt';

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
 *  - `pat`: a Personal Access Token (`crowi_pat_…` opaque Bearer,
 *    RFC-0010 Phase 2). Scopes are the stored token's `scopes`; `tokenId`
 *    is the PAT document id. Handlers that must stay web-session-only
 *    (e.g. PAT management) branch on `kind !== 'web'`.
 */
export type AuthContext = { kind: 'web' } | { kind: 'oauth'; clientId: string } | { kind: 'pat'; tokenId: string };

export interface HonoAuthVariables {
  user: UserDocument;
  /** Scopes the authenticated principal holds (web sessions = all). */
  authScopes: ReadonlySet<Scope>;
  /** How the request authenticated; lets handlers branch web vs. OAuth. */
  authContext: AuthContext;
}

export const createJwtAuth = (crowi: Crowi) => {
  const User = crowi.model('User');
  const PersonalAccessToken = crowi.model('PersonalAccessToken');
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

    // Resolve the request's principal up front. Three credential shapes:
    //   - `crowi_pat_…` opaque Bearer → Personal Access Token (RFC-0010
    //     Phase 2): looked up by SHA-256 hash, scopes from the stored row.
    //   - JWT `access` (Bearer or cookie) → web session, all scopes.
    //   - JWT `oauth_access` (Bearer only) → OAuth token, claim scopes.
    // `resolved` carries the user plus a deferred scope/context applier so
    // the shared status check below runs once for every credential shape.
    //
    // `sessionAuthVersion` is the web-session revocation claim: `false`
    // means "not a web session" (PAT / OAuth — revoked through their own
    // records, so the generation check must not apply to them), otherwise
    // it is the token's `av` claim, `undefined` for tokens minted before
    // the claim existed.
    let resolved: { userId: string; sessionAuthVersion: number | undefined | false; apply: () => Promise<void> } | null = null;

    const isPat = !fromCookie && token.startsWith(PersonalAccessToken.TOKEN_PREFIX);

    if (isPat) {
      const record = await PersonalAccessToken.findActiveByHash(PersonalAccessToken.hashToken(token));
      // A missing / revoked / expired PAT is filtered out by
      // `findActiveByHash`'s query, so a null result is an ordinary 401.
      if (!record) {
        return c.json(AUTH_REQUIRED_BODY, 401);
      }
      const tokenId = record._id.toString();
      resolved = {
        userId: record.userId.toString(),
        sessionAuthVersion: false,
        apply: async () => {
          const scopes = new Set<Scope>();
          for (const s of record.scopes) {
            if (isScope(s)) scopes.add(s);
          }
          c.set('authScopes', scopes);
          c.set('authContext', { kind: 'pat', tokenId });
          // Best-effort last-used bump; never blocks the request.
          await record.touchLastUsed();
        },
      };
    } else {
      // Bearer: accept both web-session (`access`) and OAuth
      // (`oauth_access`) tokens. Cookie: web-session only.
      const payload = fromCookie ? jwtUtil.verifyToken(token, 'access') : jwtUtil.verifyToken(token, ['access', 'oauth_access'] as const);
      if (!payload) {
        return c.json(AUTH_REQUIRED_BODY, 401);
      }
      resolved = {
        userId: payload.userId,
        // OAuth access tokens are not web sessions; only `access` (Bearer
        // or the cookie fallback) carries the session generation.
        sessionAuthVersion: payload.type === 'oauth_access' ? false : payload.av,
        apply: async () => {
          // Web sessions (`access`, or the cookie fallback) get every scope
          // so `requireScope` always passes and UI behaviour is unchanged.
          // OAuth tokens are limited to their parsed `scope` claim.
          if (payload.type === 'oauth_access') {
            c.set('authScopes', parseScopeClaim(payload.scope));
            c.set('authContext', { kind: 'oauth', clientId: payload.client_id });
          } else {
            c.set('authScopes', ALL_SCOPES);
            c.set('authContext', { kind: 'web' });
          }
        },
      };
    }

    // NOTE (deliberately no try/catch): a genuine authentication failure is
    // always an explicit early return (401 / 403) below. Everything that can
    // *throw* here — `User.findById`, `resolved.apply()` (e.g. a PAT
    // last-used write) — is infrastructure, and a throw from `await next()` is
    // a downstream handler error; both must surface as a 500 via the app's
    // `onError` (error-handler.ts), NOT be masked as `AUTHENTICATION_REQUIRED`
    // 401. The previous `try { … await next() } catch { return 401 }` wrapper
    // turned a transient DB failure (and any handler throw) into a spurious
    // 401 — hiding real 500s from clients/logs. Because a throw here
    // short-circuits before `next()`, the boundary stays fail-closed: an
    // unauthenticated request never reaches the handler.
    const user = await User.findById(resolved.userId);
    if (!user) {
      return c.json(AUTH_REQUIRED_BODY, 401);
    }

    // Web-session revocation. Piggybacks on the `findById` above, so it
    // costs no extra query. A password change bumps `user.authVersion`,
    // which strands every token minted before it — including one an
    // attacker already holds. PAT / OAuth credentials skip this
    // (`sessionAuthVersion === false`); they have their own revocation.
    if (resolved.sessionAuthVersion !== false && !isCurrentAuthVersion(resolved.sessionAuthVersion, user)) {
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

    // RFC-0010 scope resolution — deferred to the credential-specific
    // applier so this status-check path is shared across web / OAuth /
    // PAT. Sets `authScopes` + `authContext` (and, for PATs, bumps
    // `lastUsedAt`).
    await resolved.apply();

    await next();
  });
};
