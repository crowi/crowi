/**
 * RFC-0010 Phase 3 — OAuth 2.0 authorization-server endpoints.
 *
 *   POST /oauth/authorize                          — JWT (web session only)
 *   POST /oauth/token                              — public (RFC 6749)
 *   POST /oauth/revoke                             — public (RFC 7009)
 *   GET  /.well-known/oauth-authorization-server   — public (RFC 8414)
 *
 * `/oauth/authorize` rides a per-path `createJwtAuth(crowi)` apply (no
 * other handler owns `/oauth/*`, so the apply is self-contained, mirroring
 * `tokenAuth`'s `/auth/logout` install). It is **web-session only**
 * (PHASE3-Q9): minting an authorization code from a PAT / OAuth token
 * would let a token spawn a fresh, possibly broader token — a privilege
 * escalation — so a non-`web` `authContext` is rejected with 403.
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
import type { ForbiddenError, OAuthError } from '@crowi/api-contract';
import { DISCOVERY_SCOPES_SUPPORTED, GRANT_TYPES_SUPPORTED, TokenRequestSchema, isScope, scopeSatisfies } from '@crowi/api-contract';
import { authorizeRoute, discoveryRoute, revokeRoute, tokenRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { createJwtUtil } from 'src/util/jwt';
import { isRedirectUriAllowed } from 'src/util/oauth-redirect-uri';
import { verifyPkceS256 } from 'src/util/pkce';

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

const FORBIDDEN_BODY: ForbiddenError = {
  error: {
    code: 'FORBIDDEN',
    message: 'Authorization codes can only be issued from a web session.',
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
  const PersonalAccessToken = crowi.model('PersonalAccessToken');
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  // `/oauth/authorize` requires an authenticated web session. The other
  // three routes are public, so we install jwtAuth on the single literal
  // path only (same per-path install as `tokenAuth`'s `/auth/logout`).
  app.use('/oauth/authorize', createJwtAuth(crowi));

  /**
   * Build the issuer base URL for discovery. Prefers the configured
   * `app:url`; falls back to the request's Host (honouring a reverse
   * proxy's `X-Forwarded-*`). Trailing slash trimmed.
   */
  const issuerBaseUrl = (c: Context): string => {
    const configured = crowi.getConfig()?.crowi?.['app:url'];
    if (configured && typeof configured === 'string') {
      return configured.replace(/\/$/, '');
    }
    const proto = c.req.header('x-forwarded-proto') ?? 'http';
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost';
    return `${proto}://${host}`;
  };

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
        // allowed set.
        const requested = scope.split(/\s+/).filter((s) => s.length > 0);
        const allowed = new Set(client.allowedScopes);
        const granted = requested.filter((s) => isScope(s) && allowed.has(s));
        if (granted.length === 0 || granted.length !== requested.length) {
          return c.json(oauthError('invalid_scope', 'One or more requested scopes are not permitted for this client'), 400);
        }

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
            const known = await OAuthRefreshToken.findOne({ tokenHash: presentedHash });
            if (known) {
              await OAuthRefreshToken.revokeChain(presentedHash);
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
      // authorization_endpoint is the *web* consent screen (browser
      // destination); token / revocation are the /api/v2 API (RFC-0010,
      // PHASE3-Q6). Both share the same origin in the default deployment.
      const issuer = issuerBaseUrl(c);
      const apiBase = `${issuer}/api/v2`;
      return c.json(
        {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${apiBase}/oauth/token`,
          revocation_endpoint: `${apiBase}/oauth/revoke`,
          scopes_supported: [...DISCOVERY_SCOPES_SUPPORTED],
          response_types_supported: ['code'],
          grant_types_supported: [...GRANT_TYPES_SUPPORTED],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        },
        200,
      );
    });

  /** Mint a fresh access (JWT) + refresh (DB-backed) pair for a grant. */
  async function issueTokens(user: { _id: { toString(): string }; email: string }, clientId: string, scopes: string[]) {
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
