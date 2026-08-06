/**
 * Hono port of the Express `jwtAuth` middleware, generalised into a shared
 * credential-resolution core (`resolveCredential`) that every auth boundary
 * in the api (`createJwtAuth`, `createAttachmentAuth` below, and
 * `mcp/auth.ts#createMcpAuth`) calls with its own `CredentialPolicy`.
 *
 * feature-auth-cookie-fallback-scope — the boundaries diverge on exactly
 * two axes:
 *
 *   - `cookieEligible`: may an ABSENT Authorization header fall back to the
 *     `crowi.accessToken` cookie? A header that is PRESENT but malformed
 *     (garbage, `Basic ...`, empty, `Bearer` with no token) is never treated
 *     as absent and never falls back to the cookie, regardless of this flag
 *     — see `resolveCredential`'s doc comment. `createJwtAuth` and
 *     `createMcpAuth` are always `false`; `createAttachmentAuth` is `true`
 *     only for GET/HEAD on the three headerless delivery routes.
 *   - `headerTokenKinds`: which Bearer credential kinds a boundary accepts
 *     via the header (`pat` / `access` / `oauth_access`). `createJwtAuth`
 *     and `createAttachmentAuth` accept all three; `createMcpAuth` accepts
 *     only `pat` (RFC-0022 §6.2/§7 — OAuth resource/audience binding is not
 *     implemented yet, so `oauth_access` is rejected at this boundary until
 *     it is).
 *
 * Every boundary shares the rest: 401 `AUTHENTICATION_REQUIRED` on missing /
 * invalid / expired token or unknown user (body shape matches
 * `AuthenticationRequiredErrorSchema`), 403 `USER_REGISTERED` /
 * `USER_SUSPENDED` / `USER_INVITED` for non-active accounts (body shape
 * matches `UserStatusErrorSchema`), and on success the resolved
 * `UserDocument` / scopes / `AuthContext` exposed via `c.get(...)`.
 */
import type { AuthenticationRequiredErrorSchema, Scope, UserStatusErrorSchema } from '@crowi/api-contract';
import { ALL_SCOPES, isScope, parseScopeClaim } from '@crowi/api-contract';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil, isCurrentAuthVersion } from 'src/util/jwt';
import type { z } from 'zod';

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
 *  - `web`: a browser session JWT (`type: 'access'`), presented either as a
 *    Bearer header or (feature-auth-cookie-fallback-scope: only where
 *    `cookieEligible`) the `crowi.accessToken` cookie fallback — `via`
 *    (RFC-0019 §7.5 credential provenance) records which. Carries no scope
 *    claim and is granted **all** scopes, so `requireScope` always passes
 *    and the existing UI behaviour is unchanged.
 *  - `oauth`: an OAuth access token (`type: 'oauth_access'`). Scopes are
 *    limited to the token's `scope` claim and `clientId` identifies the
 *    issuing client.
 *  - `pat`: a Personal Access Token (`crowi_pat_…` opaque Bearer,
 *    RFC-0010 Phase 2). Scopes are the stored token's `scopes`; `tokenId`
 *    is the PAT document id. Handlers that must stay web-session-only
 *    (e.g. PAT management) branch on `kind !== 'web'`.
 */
export type AuthContext = { kind: 'web'; via: 'header' | 'cookie' } | { kind: 'oauth'; clientId: string } | { kind: 'pat'; tokenId: string };

export interface HonoAuthVariables {
  user: UserDocument;
  /** Scopes the authenticated principal holds (web sessions = all). */
  authScopes: ReadonlySet<Scope>;
  /** How the request authenticated; lets handlers branch web vs. OAuth. */
  authContext: AuthContext;
}

/** Header-Bearer credential kinds a `CredentialPolicy` may accept. The cookie fallback is always `access`-only, gated separately by `cookieEligible`. */
export type HeaderTokenKind = 'pat' | 'access' | 'oauth_access';

/**
 * Per-boundary auth policy — see this file's header comment for what each
 * field means and which boundary sets it to what.
 */
export interface CredentialPolicy {
  cookieEligible: boolean;
  headerTokenKinds: ReadonlySet<HeaderTokenKind>;
}

/** Every header-Bearer credential kind — the `createJwtAuth` / `createAttachmentAuth` default. */
export const HEADER_TOKEN_KINDS_STANDARD: ReadonlySet<HeaderTokenKind> = new Set(['pat', 'access', 'oauth_access']);

export type CredentialResolution = { ok: true } | { ok: false; status: 401 } | { ok: false; status: 403; body: UserStatusError };

/** Models + util `resolveCredential` needs — built once per middleware factory call, not per request. */
export const createAuthDeps = (crowi: Crowi) => ({
  User: crowi.model('User'),
  PersonalAccessToken: crowi.model('PersonalAccessToken'),
  jwtUtil: createJwtUtil(crowi),
});

export type AuthDeps = ReturnType<typeof createAuthDeps>;

/**
 * Shared credential-resolution core for every auth boundary in the api.
 * Resolves the request's principal per `policy`, runs the shared active-user
 * check, and on success sets `user` / `authScopes` / `authContext` on `c`
 * itself (callers just branch on the returned `ok`).
 *
 * Credential precedence (design decision 1 / AC-1):
 *
 *   1. `Authorization` header PRESENT (even `''`, even malformed) → resolve
 *      strictly from the header. `extractTokenFromHeader` rejects anything
 *      that isn't a well-formed `Bearer <token>`, and that rejection is a
 *      straight 401 — the cookie is NEVER consulted once a header exists.
 *      This is the bug this spec closes: previously any header the api
 *      couldn't parse (garbage, `Basic ...`, empty, `Bearer` with no token)
 *      was treated the same as "no header" and fell back to the cookie.
 *   2. `Authorization` header ABSENT (`undefined`) AND `policy.cookieEligible`
 *      → try the `crowi.accessToken` cookie (`access` JWT only, never a
 *      PAT or `oauth_access`).
 *   3. Otherwise → unresolved, 401.
 *
 * A resolved header credential must also match `policy.headerTokenKinds`
 * (RFC-0022 PAT-only `/mcp` uses this to reject a web-session or
 * `oauth_access` Bearer at the boundary, before any user/DB lookup differs
 * from the PAT path — design decision 4).
 *
 * Deliberately no try/catch around `User.findById` / the deferred `apply()`
 * (PAT `touchLastUsed()`): both can throw on genuine infrastructure failure,
 * and that must surface as a 500 via the app's `onError`, never be masked as
 * `AUTHENTICATION_REQUIRED` 401. `apply()` — and therefore `touchLastUsed()`
 * — only ever runs after the active-user status check below, so a suspended
 * account's PAT never bumps `lastUsedAt`.
 */
export async function resolveCredential(c: Context<{ Variables: HonoAuthVariables }>, deps: AuthDeps, policy: CredentialPolicy): Promise<CredentialResolution> {
  const { User, PersonalAccessToken, jwtUtil } = deps;
  const authHeader = c.req.header('authorization');

  let token: string | null = null;
  let fromCookie = false;

  if (authHeader !== undefined) {
    // A PRESENT Authorization field — however malformed — is an explicit
    // (and here, failed) credential attempt. It must never be treated as
    // "no header" and fall back to the cookie.
    token = jwtUtil.extractTokenFromHeader(authHeader);
    if (!token) {
      return { ok: false, status: 401 };
    }
  } else if (policy.cookieEligible) {
    const cookieToken = getCookie(c, ACCESS_TOKEN_COOKIE_NAME)?.trim();
    if (cookieToken) {
      token = cookieToken;
      fromCookie = true;
    }
  }

  if (!token) {
    return { ok: false, status: 401 };
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
  let resolved: { userId: string; sessionAuthVersion: number | undefined | false; apply: (user: UserDocument) => Promise<void> } | null = null;

  const isPat = !fromCookie && token.startsWith(PersonalAccessToken.TOKEN_PREFIX);

  if (isPat) {
    if (!policy.headerTokenKinds.has('pat')) {
      return { ok: false, status: 401 };
    }
    const record = await PersonalAccessToken.findActiveByHash(PersonalAccessToken.hashToken(token));
    // A missing / revoked / expired PAT is filtered out by
    // `findActiveByHash`'s query, so a null result is an ordinary 401.
    if (!record) {
      return { ok: false, status: 401 };
    }
    const tokenId = record._id.toString();
    resolved = {
      userId: record.userId.toString(),
      sessionAuthVersion: false,
      apply: async (user) => {
        const scopes = new Set<Scope>();
        for (const s of record.scopes) {
          if (isScope(s)) scopes.add(s);
        }
        c.set('user', user);
        c.set('authScopes', scopes);
        c.set('authContext', { kind: 'pat', tokenId });
        // Last-used bump: "best-effort" in the sense that a write failure
        // here is infrastructure, not an auth failure — it is NEVER masked
        // as a 401 (see this file's top-level NOTE). It IS awaited, so the
        // request does wait on it, and a rejection propagates up through
        // `apply()` / `resolveCredential` to surface as a 500 via the app's
        // `onError`, same as any other infra throw in this function.
        await record.touchLastUsed();
      },
    };
  } else {
    // Bearer: header may carry web-session (`access`) and/or OAuth
    // (`oauth_access`) per `policy.headerTokenKinds`. Cookie: web-session
    // only, always, regardless of policy — a PAT/OAuth credential can never
    // ride the cookie.
    const candidateTypes = fromCookie ? (['access'] as const) : (['access', 'oauth_access'] as const).filter((t) => policy.headerTokenKinds.has(t));

    if (candidateTypes.length === 0) {
      return { ok: false, status: 401 };
    }

    const payload = jwtUtil.verifyToken(token, candidateTypes);
    if (!payload) {
      return { ok: false, status: 401 };
    }
    resolved = {
      userId: payload.userId,
      // OAuth access tokens are not web sessions; only `access` (Bearer
      // or the cookie fallback) carries the session generation.
      sessionAuthVersion: payload.type === 'oauth_access' ? false : payload.av,
      apply: async (user) => {
        // Web sessions (`access`, or the cookie fallback) get every scope
        // so `requireScope` always passes and UI behaviour is unchanged.
        // OAuth tokens are limited to their parsed `scope` claim.
        c.set('user', user);
        if (payload.type === 'oauth_access') {
          c.set('authScopes', parseScopeClaim(payload.scope));
          c.set('authContext', { kind: 'oauth', clientId: payload.client_id });
        } else {
          c.set('authScopes', ALL_SCOPES);
          c.set('authContext', { kind: 'web', via: fromCookie ? 'cookie' : 'header' });
        }
      },
    };
  }

  const user = await User.findById(resolved.userId);
  if (!user) {
    return { ok: false, status: 401 };
  }

  // Web-session revocation. Piggybacks on the `findById` above, so it
  // costs no extra query. A password change bumps `user.authVersion`,
  // which strands every token minted before it — including one an
  // attacker already holds. PAT / OAuth credentials skip this
  // (`sessionAuthVersion === false`); they have their own revocation.
  if (resolved.sessionAuthVersion !== false && !isCurrentAuthVersion(resolved.sessionAuthVersion, user)) {
    return { ok: false, status: 401 };
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

    return { ok: false, status: 403, body: { error: { code, message, redirectTo } } };
  }

  // RFC-0010 scope resolution — deferred to the credential-specific
  // applier so this status-check path is shared across web / OAuth / PAT.
  // Sets `user` / `authScopes` / `authContext` (and, for PATs, bumps
  // `lastUsedAt`) only now that the account is confirmed active.
  await resolved.apply(user as UserDocument);

  return { ok: true };
}

/** `c.json(...)` for a `resolveCredential` failure — shared by the two REST boundaries below (`createJwtAuth`, `createAttachmentAuth`). `mcp/auth.ts#createMcpAuth` maps 401 to a JSON-RPC envelope instead, so it does not use this helper. */
const respondToCredentialFailure = (c: Context, result: Extract<CredentialResolution, { ok: false }>) => {
  if (result.status === 401) {
    return c.json(AUTH_REQUIRED_BODY, 401);
  }
  return c.json(result.body, 403);
};

/**
 * NOTE (deliberately no try/catch): a genuine authentication failure is
 * always an explicit early return (401 / 403) from `resolveCredential`
 * below. Everything that can *throw* — `User.findById`, `resolved.apply()`
 * (e.g. a PAT last-used write), a downstream handler error from `next()` —
 * is infrastructure/handler, and must surface as a 500 via the app's
 * `onError` (error-handler.ts), NOT be masked as `AUTHENTICATION_REQUIRED`
 * 401. Because a throw short-circuits before `next()`, the boundary stays
 * fail-closed: an unauthenticated request never reaches the handler.
 */
export const createJwtAuth = (crowi: Crowi) => {
  const deps = createAuthDeps(crowi);

  return createMiddleware<{ Variables: HonoAuthVariables }>(async (c, next) => {
    const result = await resolveCredential(c, deps, { cookieEligible: false, headerTokenKinds: HEADER_TOKEN_KINDS_STANDARD });
    if (!result.ok) {
      return respondToCredentialFailure(c, result);
    }
    await next();
  });
};

/**
 * `/attachments/*` auth boundary (feature-auth-cookie-fallback-scope design
 * decision 3). Same core and the same header-only default as `createJwtAuth`
 * — the only difference is that GET/HEAD requests to the three headerless
 * delivery routes (`/attachments/:id`, `/attachments/:id/original`,
 * `/attachments/by-key/*`) are `cookieEligible`, because the browser cannot
 * attach an Authorization header to an `<img src>` / direct-navigation
 * request. Every other `/attachments/*` route (meta, upload, remove) and
 * every non-GET/HEAD method on the three delivery routes stays header-only.
 *
 * Installed exactly once, on the broad `/attachments/*` wildcard
 * (`handlers/attachment.ts`) — the literal streaming mounts
 * (`handlers/attachment-stream.ts`) deliberately do NOT install it again
 * (that would double-run credential resolution — double JWT/PAT verify,
 * double `User.findById`, double `touchLastUsed()` — for every request that
 * matches both the wildcard and a literal mount). Evaluating `c.req.method` /
 * `c.req.path` per request (rather than baking eligibility into the mount
 * point) is what lets the single wildcard install make the correct
 * eligibility decision for every literal route underneath it.
 */
export const createAttachmentAuth = (crowi: Crowi) => {
  const deps = createAuthDeps(crowi);

  return createMiddleware<{ Variables: HonoAuthVariables }>(async (c, next) => {
    const cookieEligible = isAttachmentDeliveryRequest(c.req.method, c.req.path);
    const result = await resolveCredential(c, deps, { cookieEligible, headerTokenKinds: HEADER_TOKEN_KINDS_STANDARD });
    if (!result.ok) {
      return respondToCredentialFailure(c, result);
    }
    await next();
  });
};

const ATTACHMENT_BY_ID_RE = /^\/attachments\/[0-9a-fA-F]{24}$/;
const ATTACHMENT_ORIGINAL_RE = /^\/attachments\/[0-9a-fA-F]{24}\/original$/;
const ATTACHMENT_BY_KEY_PREFIX = '/attachments/by-key/';

/**
 * The three headerless attachment delivery routes cookie fallback exists
 * for (see `createAttachmentAuth`'s doc comment): GET/HEAD by-id, by-id
 * `/original`, and `by-key/*`. `path` is the request path as seen inside
 * this Hono app — already stripped of the `/api` prefix
 * (`hono/path-rewrite.ts`) — so it matches the routes' own registered
 * patterns verbatim.
 */
export const isAttachmentDeliveryRequest = (method: string, path: string): boolean => {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return ATTACHMENT_BY_ID_RE.test(path) || ATTACHMENT_ORIGINAL_RE.test(path) || path.startsWith(ATTACHMENT_BY_KEY_PREFIX);
};
