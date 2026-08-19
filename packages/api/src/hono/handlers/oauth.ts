/**
 * RFC-0010 Phase 3+4 — OAuth 2.0 authorization-server endpoints.
 *
 *   POST /oauth/authorize                          — JWT (web session only)
 *   POST /oauth/token                              — public (RFC 6749 / 8628)
 *   POST /oauth/revoke                             — public (RFC 7009)
 *   GET  /.well-known/oauth-authorization-server   — public (RFC 8414)
 *   POST /oauth/device/authorize                   — public (RFC 8628 §3.1)
 *   GET  /oauth/device                             — public (consent lookup)
 *   POST /oauth/device/verify                      — JWT (web session only)
 *   GET  /oauth/client-info                        — public (RFC-0016 §4.4, client metadata lookup)
 *
 * `/oauth/authorize` and `/oauth/device/verify` ride per-path
 * `createJwtAuth(crowi)` applies (no other handler owns `/oauth/*`, so the
 * applies are self-contained, mirroring `tokenAuth`'s `/auth/logout`
 * install). Both are **web-session only** (PHASE3-Q9 / PHASE4-Q5): minting
 * an authorization code or approving a device authorization from a PAT /
 * OAuth token would let a token spawn a fresh, possibly broader token — a
 * privilege escalation — so a non-`web` `authContext` is rejected with 403.
 *
 * `/oauth/token` + `/oauth/revoke` are public. They accept
 * `application/x-www-form-urlencoded` (RFC 6749 / 7009) **and** JSON, and
 * emit the RFC 6749 §5.2 error envelope `{ error, error_description }`
 * rather than Crowi's `{ error: { code, message } }`. Because the form
 * shape would trip the zod-openapi json validator (and produce the wrong
 * envelope), their contracts declare no request body and the handler
 * parses + validates manually.
 *
 * Token storage: authorization codes and refresh tokens are stored as
 * SHA-256 hashes only; the plaintext is returned once and never persisted
 * (same model as PATs). Access tokens are stateless scope-bearing JWTs
 * (`signOauthAccessToken`).
 */
import type { ForbiddenError, NotFoundError, OAuthError } from '@crowi/api-contract';
import {
  authorizeRoute,
  clientInfoRoute,
  DISCOVERY_SCOPES_SUPPORTED,
  deviceAuthorizeRoute,
  deviceInfoRoute,
  deviceVerifyRoute,
  discoveryRoute,
  GRANT_TYPES_SUPPORTED,
  isScope,
  revokeRoute,
  scopeSatisfies,
  TokenRequestSchema,
  tokenRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Context } from 'hono';
import type { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import { createJwtUtil } from 'src/util/jwt';
import { isRedirectUriAllowed } from 'src/util/oauth-redirect-uri';
import { isWithinReuseGrace } from 'src/util/oauth-refresh-grace';
import { verifyPkceS256 } from 'src/util/pkce';
import { normalizeUserCode } from 'src/util/user-code';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:oauth');

/** Authorization codes live ~60s (RFC 6749 §4.1.2 recommends ≤10min). */
const AUTH_CODE_TTL_MS = 60 * 1000;
/** Refresh tokens live 30 days, matching the web-session refresh TTL. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Access token TTL (seconds), echoed in `expires_in` + the JWT lifetime. */
const ACCESS_TOKEN_TTL_SEC = Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS) || 60 * 60;
/** Device codes live ~10min (RFC 8628 general value). */
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** Default minimum poll spacing for the device grant (seconds, RFC 8628 §3.2). */
const DEVICE_POLL_INTERVAL_SEC = 5;

/** Dev fallback web origin when `CLIENT_URL` is unset (matches `.env.example`). */
const DEV_CLIENT_BASE_URL = 'http://localhost:4302';

const FORBIDDEN_BODY: ForbiddenError = {
  error: {
    code: 'FORBIDDEN',
    message: 'Authorization codes can only be issued from a web session.',
  },
};

const DEVICE_FORBIDDEN_BODY: ForbiddenError = {
  error: {
    code: 'FORBIDDEN',
    message: 'Device authorizations can only be approved from a web session.',
  },
};

const DEVICE_NOT_FOUND_BODY: NotFoundError = {
  error: {
    code: 'NOT_FOUND',
    message: 'No pending device authorization for this code.',
  },
};

const CLIENT_NOT_FOUND_BODY: NotFoundError = {
  error: {
    code: 'NOT_FOUND',
    message: 'No client is registered with this client_id.',
  },
};

const oauthError = (error: OAuthError['error'], description?: string): OAuthError => ({
  error,
  ...(description ? { error_description: description } : {}),
});

/**
 * Read a request body as a plain record from either JSON or
 * `application/x-www-form-urlencoded` (RFC 6749 / 7009). Returns `{}` on a
 * malformed / empty body so the schema validation downstream produces the
 * domain error rather than a thrown 400.
 */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await c.req.json()) as Record<string, unknown>;
    }
    // form-urlencoded (or anything else with a parseable body).
    const form = await c.req.parseBody();
    return form as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const registerOAuthRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const OAuthClient = crowi.model('OAuthClient');
  const OAuthAuthorizationCode = crowi.model('OAuthAuthorizationCode');
  const OAuthRefreshToken = crowi.model('OAuthRefreshToken');
  const OAuthDeviceCode = crowi.model('OAuthDeviceCode');
  const PersonalAccessToken = crowi.model('PersonalAccessToken');
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  // `/oauth/authorize` and `/oauth/device/verify` both require an
  // authenticated web session. The other routes are public, so we install
  // jwtAuth on each literal path only (same per-path install as `tokenAuth`'s
  // `/auth/logout`). `/oauth/device/authorize`, `/oauth/device` (lookup) and
  // `/oauth/token` (incl. the device grant) stay public.
  app.use('/oauth/authorize', createJwtAuth(crowi));
  app.use('/oauth/device/verify', createJwtAuth(crowi));

  /**
   * Validate a client + space-delimited scope string (shared by the
   * authorize-code and device-code authorization endpoints). Returns the
   * granted scope list, or an `oauthError` envelope describing the failure.
   * `redirect_uri` validation is authorize-specific and intentionally not
   * handled here (the device flow has no redirect_uri).
   */
  const validateClientAndScopes = async (clientId: string, scopeStr: string): Promise<{ granted: string[] } | { error: OAuthError }> => {
    const client = await OAuthClient.findByClientId(clientId);
    if (!client) {
      return { error: oauthError('invalid_client', 'Unknown client') };
    }
    const requested = scopeStr.split(/\s+/).filter((s) => s.length > 0);
    const allowed = new Set(client.allowedScopes);
    const granted = requested.filter((s) => isScope(s) && allowed.has(s));
    if (granted.length === 0 || granted.length !== requested.length) {
      return { error: oauthError('invalid_scope', 'One or more requested scopes are not permitted for this client') };
    }
    return { granted };
  };

  /**
   * Public base URL of the trusted web client — the single origin every
   * browser-facing OAuth URL (discovery `issuer`, authorize / device consent
   * pages) and every advertised API endpoint is built from.
   *
   * Sourced from `crowi.getBaseUrl()` (i.e. the `CLIENT_URL` env, the same
   * trusted origin used for CORS and absolute email links — RFC-0010). It is
   * deliberately **not** derived from the request `Host` / `X-Forwarded-Host`
   * header: those are attacker-controllable, and a forged Host would poison
   * the discovery document and the device `verification_uri`, steering a
   * victim to an attacker origin. Falls back to the dev web origin when
   * `CLIENT_URL` is unset (a fixed localhost, never the request Host).
   */
  const clientBaseUrl = (): string => (crowi.getBaseUrl() || DEV_CLIENT_BASE_URL).replace(/\/$/, '');

  return app
    .openapi(authorizeRoute, async (c) => {
      // Web-session only — a token must never mint a fresh token.
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const user = c.get('user');
      const { client_id, redirect_uri, scope, code_challenge, code_challenge_method, state } = c.req.valid('json');

      try {
        const client = await OAuthClient.findByClientId(client_id);
        if (!client) {
          return c.json(oauthError('invalid_client', 'Unknown client'), 400);
        }

        // redirect_uri must be registered (loopback host match, any port);
        // validate before anything else so we never bounce a code to an
        // attacker-controlled URI.
        if (!isRedirectUriAllowed(client, redirect_uri)) {
          return c.json(oauthError('invalid_request', 'redirect_uri is not registered for this client'), 400);
        }

        // PKCE is mandatory and S256-only (the schema already pins the
        // method; this guard documents the requirement defensively).
        if (code_challenge_method !== 'S256' || !code_challenge) {
          return c.json(oauthError('invalid_request', 'PKCE S256 challenge is required'), 400);
        }

        // Requested scopes must be catalog scopes AND within the client's
        // allowed set (shared with the device-authorize endpoint).
        const scopeCheck = await validateClientAndScopes(client_id, scope);
        if ('error' in scopeCheck) {
          return c.json(scopeCheck.error, 400);
        }
        const { granted } = scopeCheck;

        const { code, codeHash } = OAuthAuthorizationCode.generateCode();
        await OAuthAuthorizationCode.create({
          codeHash,
          clientId: client_id,
          userId: user._id,
          scopes: granted,
          codeChallenge: code_challenge,
          codeChallengeMethod: 'S256',
          redirectUri: redirect_uri,
          expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
        });

        const url = new URL(redirect_uri);
        url.searchParams.set('code', code);
        if (state != null) url.searchParams.set('state', state);

        return c.json({ redirectUri: url.toString() }, 200);
      } catch (err) {
        debug('authorize failed:', err);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(tokenRoute, async (c) => {
      const raw = await readBody(c);
      const parsed = TokenRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(oauthError('invalid_request', 'Malformed token request'), 400);
      }
      const body = parsed.data;

      try {
        if (body.grant_type === 'authorization_code') {
          // Atomic single-use consume: a second exchange of the same code
          // returns null (consumedAt already set) → invalid_grant.
          const record = await OAuthAuthorizationCode.consume(OAuthAuthorizationCode.hashCode(body.code));
          if (!record) {
            return c.json(oauthError('invalid_grant', 'Authorization code is invalid, expired, or already used'), 400);
          }
          if (record.clientId !== body.client_id || record.redirectUri !== body.redirect_uri) {
            return c.json(oauthError('invalid_grant', 'client_id / redirect_uri mismatch'), 400);
          }
          if (!verifyPkceS256(body.code_verifier, record.codeChallenge)) {
            return c.json(oauthError('invalid_grant', 'PKCE verification failed'), 400);
          }

          const user = await User.findById(record.userId);
          if (!user || user.status !== User.STATUS_ACTIVE) {
            return c.json(oauthError('invalid_grant', 'User is no longer active'), 400);
          }

          return c.json(await issueTokens(user, record.clientId, record.scopes), 200);
        }

        if (body.grant_type === 'refresh_token') {
          const presentedHash = OAuthRefreshToken.hashToken(body.refresh_token);
          const active = await OAuthRefreshToken.findActiveByHash(presentedHash);

          if (!active) {
            // Reuse detection: a known-but-revoked token presented again is
            // the signature of a stolen-token replay — revoke the whole
            // rotation chain so neither the attacker nor the legitimate
            // holder can continue (RFC-0010 §Security, PHASE3-Q5).
            //
            // Exception (spec §D-2): the same signature also fires when two
            // legitimate concurrent refreshes race on the same token — the
            // loser presents the token the winner just rotated away. If
            // `revokedAt` is within the grace window, suppress the chain
            // revocation instead of firing it. The response is identical
            // either way (§D-2): the client never learns whether it landed
            // inside or outside the window, and no token — successor or
            // otherwise — is ever returned here (§D-1).
            const known = await OAuthRefreshToken.findOne({ tokenHash: presentedHash });
            if (known) {
              if (known.revokedAt && isWithinReuseGrace(known.revokedAt)) {
                // §D-4: record that a revocation was suppressed, without any
                // value that could be used to look up or replay the token.
                debug('refresh reuse suppressed within grace window: clientId=%s elapsedMs=%d', known.clientId, Date.now() - known.revokedAt.getTime());
              } else {
                await OAuthRefreshToken.revokeChain(presentedHash);
              }
            }
            return c.json(oauthError('invalid_grant', 'Refresh token is invalid, expired, or revoked'), 400);
          }

          if (active.clientId !== body.client_id) {
            return c.json(oauthError('invalid_grant', 'client_id mismatch'), 400);
          }

          // Optional down-scoping: requested scopes must be a subset of the
          // token's existing scopes (no scope escalation on refresh).
          let nextScopes = active.scopes;
          if (body.scope) {
            const requested = body.scope.split(/\s+/).filter((s) => s.length > 0);
            const existing = new Set(active.scopes);
            const ok = requested.every((s) => scopeSatisfies(s, existing));
            if (!ok || requested.length === 0) {
              return c.json(oauthError('invalid_scope', 'Requested scope exceeds the granted scope'), 400);
            }
            nextScopes = requested;
          }

          const user = await User.findById(active.userId);
          if (!user || user.status !== User.STATUS_ACTIVE) {
            return c.json(oauthError('invalid_grant', 'User is no longer active'), 400);
          }

          // Rotate: issue the successor, then revoke the presented token and
          // link it to the successor (`rotatedTo`) so a later replay of the
          // old token can revoke the whole chain.
          const issued = await issueTokens(user, active.clientId, nextScopes);
          const successorHash = OAuthRefreshToken.hashToken(issued.refresh_token);
          active.revokedAt = new Date();
          active.rotatedTo = successorHash;
          await active.save();

          return c.json(issued, 200);
        }

        if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          const hash = OAuthDeviceCode.hashDeviceCode(body.device_code);
          const record = await OAuthDeviceCode.findByDeviceCodeHash(hash);
          // findByDeviceCodeHash filters consumed + expired, so a null here
          // means the code is unknown, already consumed, or past its TTL —
          // RFC 8628 §3.5 wants `expired_token` for the timeout case, which is
          // the common one for a long-lived poll loop.
          if (!record) {
            return c.json(oauthError('expired_token', 'Device code is invalid, expired, or already used'), 400);
          }
          if (record.clientId !== body.client_id) {
            return c.json(oauthError('invalid_grant', 'client_id mismatch'), 400);
          }

          // slow_down (RFC 8628 §3.5): the client polled again sooner than the
          // advertised interval. We bump lastPolledAt on every poll so the
          // window slides forward; the first poll (lastPolledAt == null) is
          // always allowed.
          const now = Date.now();
          if (record.lastPolledAt && now - record.lastPolledAt.getTime() < record.interval * 1000) {
            await OAuthDeviceCode.touchPolled(hash);
            return c.json(oauthError('slow_down', 'Polling too frequently; slow down'), 400);
          }
          await OAuthDeviceCode.touchPolled(hash);

          if (record.status === 'denied') {
            return c.json(oauthError('access_denied', 'The user denied the device authorization'), 400);
          }
          if (record.status === 'pending') {
            return c.json(oauthError('authorization_pending', 'The user has not yet completed the authorization'), 400);
          }

          // status === 'approved' — atomically consume (single use) so two
          // concurrent polls cannot both mint tokens.
          const consumed = await OAuthDeviceCode.consume(hash);
          if (!consumed) {
            return c.json(oauthError('expired_token', 'Device code is invalid, expired, or already used'), 400);
          }

          const user = await User.findById(consumed.userId);
          if (!user || user.status !== User.STATUS_ACTIVE) {
            return c.json(oauthError('invalid_grant', 'User is no longer active'), 400);
          }

          return c.json(await issueTokens(user, consumed.clientId, consumed.grantedScopes), 200);
        }

        // discriminatedUnion already constrains grant_type; this is
        // unreachable but keeps the contract explicit for SDKs.
        return c.json(oauthError('unsupported_grant_type', 'Unsupported grant_type'), 400);
      } catch (err) {
        debug('token failed:', err);
        return c.json(oauthError('invalid_request', 'Internal error processing token request'), 400);
      }
    })
    .openapi(revokeRoute, async (c) => {
      const raw = await readBody(c);
      const token = typeof raw.token === 'string' ? raw.token : null;
      // RFC 7009: always 200, even for a missing / unknown token, so the
      // endpoint never reveals which tokens exist.
      if (!token) {
        return c.json({}, 200);
      }

      try {
        if (token.startsWith(OAuthRefreshToken.TOKEN_PREFIX)) {
          // Revoke the whole rotation chain for a refresh token.
          const hash = OAuthRefreshToken.hashToken(token);
          await OAuthRefreshToken.revokeChain(hash);
        } else if (token.startsWith(PersonalAccessToken.TOKEN_PREFIX)) {
          const hash = PersonalAccessToken.hashToken(token);
          await PersonalAccessToken.updateOne({ tokenHash: hash, revokedAt: null }, { revokedAt: new Date() });
        }
        // An access-token (JWT) or unknown shape is a no-op — access tokens
        // are stateless and short-lived (RFC-0010 OQ-A); still 200.
        return c.json({}, 200);
      } catch (err) {
        debug('revoke failed (still 200 per RFC 7009):', err);
        return c.json({}, 200);
      }
    })
    .openapi(discoveryRoute, async (c) => {
      // Every URL derives from the trusted CLIENT_URL origin, never the
      // request Host. authorization_endpoint / device consent are *web*
      // pages on CLIENT_URL; token / revocation / device-authorize are the
      // /api API (reverse-proxied to the same origin in the default
      // deployment — RFC-0010, PHASE3-Q6).
      const issuer = clientBaseUrl();
      const apiBase = `${issuer}/api`;
      return c.json(
        {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${apiBase}/oauth/token`,
          revocation_endpoint: `${apiBase}/oauth/revoke`,
          device_authorization_endpoint: `${apiBase}/oauth/device/authorize`,
          scopes_supported: [...DISCOVERY_SCOPES_SUPPORTED],
          response_types_supported: ['code'],
          grant_types_supported: [...GRANT_TYPES_SUPPORTED],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        },
        200,
      );
    })
    .openapi(deviceAuthorizeRoute, async (c) => {
      // Public (RFC 8628 §3.1) — a headless client starts the device flow.
      const { client_id, scope } = c.req.valid('json');
      try {
        const scopeCheck = await validateClientAndScopes(client_id, scope);
        if ('error' in scopeCheck) {
          return c.json(scopeCheck.error, 400);
        }

        const { doc, deviceCode } = await OAuthDeviceCode.createPending({
          clientId: client_id,
          requestedScopes: scopeCheck.granted,
          expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
          interval: DEVICE_POLL_INTERVAL_SEC,
        });

        // verification_uri is the *web* device-consent page on the trusted
        // CLIENT_URL origin (never the request Host — a forged Host would
        // otherwise send the user to an attacker's site).
        const verificationUri = `${clientBaseUrl()}/oauth/device`;
        const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(doc.userCode)}`;

        return c.json(
          {
            device_code: deviceCode,
            user_code: doc.userCode,
            verification_uri: verificationUri,
            verification_uri_complete: verificationUriComplete,
            expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
            interval: DEVICE_POLL_INTERVAL_SEC,
          },
          200,
        );
      } catch (err) {
        debug('device/authorize failed:', err);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(deviceInfoRoute, async (c) => {
      // Public, lightweight lookup (PHASE4-Q9 option A): the consent screen
      // reads the requesting client + requested scopes before approving. Only
      // a *pending* row is surfaced — already-handled / expired / unknown
      // codes return 404 (no secret is ever returned).
      const { user_code } = c.req.valid('query');
      const record = await OAuthDeviceCode.findByUserCode(normalizeUserCode(user_code));
      if (!record || record.status !== 'pending') {
        return c.json(DEVICE_NOT_FOUND_BODY, 404);
      }
      return c.json({ client_id: record.clientId, scopes: record.requestedScopes }, 200);
    })
    .openapi(deviceVerifyRoute, async (c) => {
      // Web-session only — a token must never approve its own (or a broader)
      // device authorization (privilege escalation), mirroring /oauth/authorize.
      if (c.get('authContext').kind !== 'web') {
        return c.json(DEVICE_FORBIDDEN_BODY, 403);
      }
      const user = c.get('user');
      const { user_code, action } = c.req.valid('json');

      try {
        const record = await OAuthDeviceCode.findByUserCode(normalizeUserCode(user_code));
        if (!record || record.status !== 'pending') {
          return c.json(DEVICE_NOT_FOUND_BODY, 404);
        }

        if (action === 'approve') {
          // v1 consent is all-or-nothing (PHASE4-Q3): the requested scopes
          // become the granted set, matching the authorize-code consent.
          record.status = 'approved';
          record.userId = user._id;
          record.grantedScopes = record.requestedScopes;
        } else {
          record.status = 'denied';
        }
        await record.save();

        return c.json({ status: record.status === 'approved' ? ('approved' as const) : ('denied' as const) }, 200);
      } catch (err) {
        debug('device/verify failed:', err);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(clientInfoRoute, async (c) => {
      // Public, minimal lookup (RFC-0016 §4.4) — mirrors deviceInfoRoute's
      // own non-secret shape. The web authorize page reads this before
      // rendering: a trusted client skips ConsentCard entirely. Never
      // returns redirectUris / allowedScopes.
      const { client_id } = c.req.valid('query');
      const client = await OAuthClient.findByClientId(client_id);
      if (!client) {
        return c.json(CLIENT_NOT_FOUND_BODY, 404);
      }
      return c.json({ clientId: client.clientId, name: client.name, firstParty: client.firstParty, trusted: client.trusted }, 200);
    });

  /** Mint a fresh access (JWT) + refresh (DB-backed) pair for a grant. */
  async function issueTokens(user: { _id: Types.ObjectId; email: string }, clientId: string, scopes: string[]) {
    const accessToken = jwtUtil.signOauthAccessToken({
      user,
      scopes,
      clientId,
      expiresInSec: ACCESS_TOKEN_TTL_SEC,
    });
    const { token: refreshToken, tokenHash } = OAuthRefreshToken.generateToken();
    await OAuthRefreshToken.create({
      tokenHash,
      clientId,
      userId: user._id,
      scopes,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
};
