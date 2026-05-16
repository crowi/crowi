import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PresenceTokenPayloadSchema, type PresenceTokenPayload } from '@crowi/api-contract';
import Debug from 'debug';

const debug = Debug('crowi:util:presence-token');

/**
 * Issuer claim used to sign / verify presence tokens (RFC-0005).
 *
 * Deliberately distinct from the collab wsToken issuer
 * (`'crowi-collab'`, see `util/ws-token.ts`) and the HTTP access/refresh
 * token issuer (`'crowi'`). A leaked presence token must never be
 * replayable against the collab WebSocket — `/collab` carries write
 * access to the Y.Doc, `/presence` is read-only viewer tracking — so
 * the two channels verify against different `iss` claims even though
 * they share the same `WS_TOKEN_SECRET` key material.
 */
const PRESENCE_TOKEN_ISSUER = 'crowi-presence';

/**
 * Lifetime of an issued presence token. Five minutes mirrors the
 * collab wsToken TTL: short enough that a leaked token has limited
 * blast radius, long enough to cover reconnect storms. The browser
 * uses `expiresAt` to proactively re-fetch before the WebSocket would
 * otherwise be dropped.
 */
const PRESENCE_TOKEN_TTL_SECONDS = 300;

/** Claims signed into a presence token. */
export interface PresenceTokenClaims {
  userId: string;
  pageId: string;
}

export interface SignPresenceTokenResult {
  /** Compact JWT string presented by the browser on the WebSocket connect. */
  token: string;
  /** ISO 8601 expiry timestamp, mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Resolve the signing secret once per util instance.
 *
 * Presence reuses `WS_TOKEN_SECRET` rather than introducing a new env:
 * the two token kinds are isolated by their `iss` claim, so sharing the
 * key material is safe and keeps operators from having to distribute a
 * second secret. When `WS_TOKEN_SECRET` is unset we generate a random
 * in-memory secret and warn — single-instance dev still works, but
 * process restarts invalidate outstanding tokens and multi-instance
 * deployments cannot cross-verify.
 */
const resolvePresenceTokenSecret = (): string => {
  const fromEnv = process.env.WS_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    debug('presence token secret resolved from WS_TOKEN_SECRET');
    return fromEnv;
  }
  const generated = crypto.randomBytes(32).toString('base64');
  console.warn(
    '[crowi] WS_TOKEN_SECRET is not set — generated a random in-memory secret for presence tokens. ' +
      'Process restarts will invalidate outstanding presence tokens, and multi-instance deployments ' +
      'will not be able to cross-verify them. Set WS_TOKEN_SECRET to a stable base64-encoded 32-byte ' +
      'value (`openssl rand -base64 32`) in production.',
  );
  return generated;
};

/**
 * Build a sign / verify pair bound to a single resolved secret.
 *
 * Memoised for the same reason `createWsTokenUtil` is: when
 * `WS_TOKEN_SECRET` is unset, `resolvePresenceTokenSecret` mints a
 * fresh random secret per call. Two `createPresenceTokenUtil()` calls
 * would otherwise close over different secrets and the HTTP-sign /
 * WebSocket-verify pair would silently break in dev.
 */
let cachedUtil: ReturnType<typeof buildPresenceTokenUtil> | null = null;

function buildPresenceTokenUtil() {
  const secret = resolvePresenceTokenSecret();

  /**
   * Sign a presence token for the given claims. Returns the compact
   * JWT plus the absolute ISO expiry; the route serialises the
   * timestamp into `PresenceTokenResponseSchema.expiresAt`.
   */
  function signPresenceToken(claims: PresenceTokenClaims): SignPresenceTokenResult {
    // Pin `iat` ourselves so the response's `expiresAt` is exactly the
    // same instant as the JWT's `exp` claim.
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + PRESENCE_TOKEN_TTL_SECONDS;
    const token = jwt.sign({ ...claims, iat, exp }, secret, {
      issuer: PRESENCE_TOKEN_ISSUER,
      algorithm: 'HS256',
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify a presence token. Returns the validated payload, or `null`
   * for any failure (expired, bad signature, wrong issuer, malformed
   * claims). Callers must treat `null` as "reject the connection".
   */
  function verifyPresenceToken(token: string): PresenceTokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: PRESENCE_TOKEN_ISSUER,
        algorithms: ['HS256'],
      });
      const parsed = PresenceTokenPayloadSchema.safeParse(decoded);
      if (!parsed.success) {
        debug('presence token payload failed schema validation:', parsed.error.issues);
        return null;
      }
      return parsed.data;
    } catch (err) {
      debug('presence token verification failed:', (err as Error).message);
      return null;
    }
  }

  return {
    signPresenceToken,
    verifyPresenceToken,
    ttlSeconds: PRESENCE_TOKEN_TTL_SECONDS,
    issuer: PRESENCE_TOKEN_ISSUER,
  };
}

export type PresenceTokenUtil = ReturnType<typeof buildPresenceTokenUtil>;

export function createPresenceTokenUtil(): PresenceTokenUtil {
  if (cachedUtil === null) {
    cachedUtil = buildPresenceTokenUtil();
  }
  return cachedUtil;
}
