import jwt from 'jsonwebtoken';
import Crowi from 'src/crowi';
import Debug from 'debug';

const debug = Debug('crowi:util:jwt');

/**
 * Web session tokens (`access` / `refresh`) carry no scope claim and are
 * treated as "all scopes" by the auth middleware. OAuth access tokens
 * (RFC-0010) add a space-delimited `scope` claim (RFC 6749 §3.3) and the
 * issuing `client_id`. Modelled as a discriminated union on `type` so
 * only `oauth_access` payloads expose `scope` / `client_id` — web-session
 * callers can never accidentally read a scope off a session token.
 */
export type TokenPayload =
  | {
      userId: string;
      email: string;
      type: 'access' | 'refresh';
    }
  | {
      userId: string;
      email: string;
      type: 'oauth_access';
      /** space-delimited scope claim (RFC 6749 §3.3) */
      scope: string;
      client_id: string;
    };

/** Token types a Bearer credential may carry through `verifyToken`. */
export type VerifiableTokenType = TokenPayload['type'];

/**
 * Access / refresh token lifetimes in seconds. Env-overridable; the
 * 1h default for access tokens is long enough that brief idle periods
 * don't churn the refresh endpoint and short enough that a leaked
 * token stays useful for at most an hour. The client's 401 interceptor
 * (see `packages/web/src/lib/api-client.ts`) trades the refresh token
 * for a fresh access token whenever a request lands a 401.
 */
const ACCESS_TOKEN_TTL_SEC = Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS) || 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = Number(process.env.JWT_REFRESH_TOKEN_TTL_SECONDS) || 30 * 24 * 60 * 60; // 30 days

export function createJwtUtil(crowi: Crowi) {
  const config = crowi.getConfig();
  const secret = config.crowi['app:secret'] || config.crowi['SECRET_TOKEN'] || 'your-secret-key';

  /**
   * Generate access and refresh tokens for a user
   */
  function generateTokens(user: any) {
    const payload = {
      userId: user._id.toString(),
      email: user.email,
    };

    const accessToken = jwt.sign({ ...payload, type: 'access' }, secret, {
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      issuer: 'crowi',
    });

    const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, secret, {
      expiresIn: REFRESH_TOKEN_TTL_SEC,
      issuer: 'crowi',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
    };
  }

  /**
   * Sign a scope-bearing OAuth access token (RFC-0010). The real issuing
   * path (`POST /oauth/token`) lands in Phase 3; this helper exists so
   * Phase 1's scope-aware middleware can be exercised end-to-end in tests
   * (mint a token with a known scope, assert `requireScope` accepts /
   * rejects it). `scopes` is space-joined into the `scope` claim per
   * RFC 6749 §3.3. The web-session `generateTokens` path is untouched.
   */
  function signOauthAccessToken(params: {
    user: { _id: { toString(): string }; email: string };
    scopes: readonly string[];
    clientId: string;
    expiresInSec?: number;
  }): string {
    const { user, scopes, clientId, expiresInSec } = params;
    return jwt.sign(
      {
        userId: user._id.toString(),
        email: user.email,
        type: 'oauth_access',
        scope: scopes.join(' '),
        client_id: clientId,
      },
      secret,
      {
        expiresIn: expiresInSec ?? ACCESS_TOKEN_TTL_SEC,
        issuer: 'crowi',
      },
    );
  }

  /**
   * Verify and decode a token. `type` may be a single accepted type or a
   * list — passing `['access', 'oauth_access']` lets the unified Bearer
   * middleware accept both web-session and OAuth access tokens in one
   * call while still rejecting refresh tokens presented as access. The
   * decoded payload is the `TokenPayload` discriminated union, so callers
   * narrow on `payload.type` to read `scope` / `client_id`.
   */
  function verifyToken<T extends VerifiableTokenType>(token: string, type: T | readonly T[]): (TokenPayload & { type: T }) | null {
    const accepted = Array.isArray(type) ? type : [type as T];
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: 'crowi',
      }) as TokenPayload;

      if (!accepted.includes(decoded.type as T)) {
        debug(`Invalid token type. Expected ${accepted.join('|')}, got ${decoded.type}`);
        return null;
      }

      return decoded as TokenPayload & { type: T };
    } catch (error) {
      debug('Token verification failed:', error);
      return null;
    }
  }

  /**
   * Extract token from Authorization header
   */
  function extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1];
  }

  /**
   * Generate a new access token from a refresh token
   */
  async function refreshAccessToken(refreshToken: string) {
    const payload = verifyToken(refreshToken, 'refresh');
    if (!payload) {
      return null;
    }

    const User = crowi.model('User');
    const user = await User.findById(payload.userId);

    if (!user || user.status !== User.STATUS_ACTIVE) {
      return null;
    }

    return generateTokens(user);
  }

  return {
    generateTokens,
    signOauthAccessToken,
    verifyToken,
    extractTokenFromHeader,
    refreshAccessToken,
  };
}
