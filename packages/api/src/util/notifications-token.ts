import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { NotificationsTokenPayloadSchema, type NotificationsTokenPayload } from '@crowi/api-contract';
import Debug from 'debug';

const debug = Debug('crowi:util:notifications-token');

/**
 * Issuer claim used to sign / verify notifications tokens.
 *
 * Distinct from the collab wsToken issuer (`'crowi-collab'`, see
 * `util/ws-token.ts`), the presence token issuer (`'crowi-presence'`,
 * see `util/presence-token.ts`), and the HTTP access/refresh token
 * issuer (`'crowi'`). The three WebSocket issuers all share the same
 * `WS_TOKEN_SECRET` key material but verify against different `iss`
 * claims, so a leaked token for one channel is never replayable
 * against the others — `/collab` carries write access to the Y.Doc,
 * `/presence` is per-page viewer tracking, `/notifications` is the
 * per-user invalidation channel.
 */
const NOTIFICATIONS_TOKEN_ISSUER = 'crowi-notifications';

/**
 * Lifetime of an issued notifications token. 60 seconds — short enough
 * that a leaked token has minimal blast radius (the notifications
 * channel only carries `{type:'changed'}` ticks, no notification data,
 * so a hijacked subscription is a low-value target but the principle
 * of least privilege still applies). The browser uses `expiresAt` to
 * proactively re-fetch ~30s before expiry; the realistic refresh
 * cadence becomes ~30s rather than the 5-minute presence cadence.
 */
const NOTIFICATIONS_TOKEN_TTL_SECONDS = 60;

/** Claims signed into a notifications token. */
export interface NotificationsTokenClaims {
  /**
   * The requesting user's `_id`. The `/notifications/<userId>` WS
   * handshake rejects a token whose `selfUserId` does not match the
   * URL path segment so one user can never subscribe to another's
   * channel even with a valid token.
   */
  selfUserId: string;
}

export interface SignNotificationsTokenResult {
  /** Compact JWT string presented by the browser on the WebSocket connect. */
  token: string;
  /** Absolute expiry timestamp; mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Resolve the signing secret once per util instance.
 *
 * Notifications token reuses `WS_TOKEN_SECRET` rather than introducing a
 * new env: the three WS token kinds are isolated by their `iss` claim,
 * so sharing the key material is safe and keeps operators from having
 * to distribute another secret. When `WS_TOKEN_SECRET` is unset we
 * generate a random in-memory secret and warn — single-instance dev
 * still works, but process restarts invalidate outstanding tokens and
 * multi-instance deployments cannot cross-verify.
 */
const resolveNotificationsTokenSecret = (): string => {
  const fromEnv = process.env.WS_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    debug('notifications token secret resolved from WS_TOKEN_SECRET');
    return fromEnv;
  }
  const generated = crypto.randomBytes(32).toString('base64');
  console.warn(
    '[crowi] WS_TOKEN_SECRET is not set — generated a random in-memory secret for notifications tokens. ' +
      'Process restarts will invalidate outstanding notifications tokens, and multi-instance deployments ' +
      'will not be able to cross-verify them. Set WS_TOKEN_SECRET to a stable base64-encoded 32-byte ' +
      'value (`openssl rand -base64 32`) in production.',
  );
  return generated;
};

/**
 * Build a sign / verify pair bound to a single resolved secret.
 *
 * Memoised for the same reason `createWsTokenUtil` / `createPresenceTokenUtil`
 * are: when `WS_TOKEN_SECRET` is unset, `resolveNotificationsTokenSecret`
 * mints a fresh random secret per call. Two `createNotificationsTokenUtil()`
 * calls would otherwise close over different secrets and the
 * HTTP-sign / WebSocket-verify pair would silently break in dev.
 */
let cachedUtil: ReturnType<typeof buildNotificationsTokenUtil> | null = null;

function buildNotificationsTokenUtil() {
  const secret = resolveNotificationsTokenSecret();

  /**
   * Sign a notifications token for the given claims. Returns the
   * compact JWT plus the absolute expiry; the handler serialises the
   * timestamp into `NotificationsTokenResponseSchema.expiresAt`.
   */
  function signNotificationsToken(claims: NotificationsTokenClaims): SignNotificationsTokenResult {
    // Pin `iat` ourselves so the response's `expiresAt` is exactly the
    // same instant as the JWT's `exp` claim (same rationale as the
    // collab / presence token utils).
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + NOTIFICATIONS_TOKEN_TTL_SECONDS;
    const token = jwt.sign({ ...claims, iat, exp }, secret, {
      issuer: NOTIFICATIONS_TOKEN_ISSUER,
      algorithm: 'HS256',
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify a notifications token. Returns the validated payload, or
   * `null` for any failure (expired, bad signature, wrong issuer,
   * malformed claims). Callers must treat `null` as "reject the
   * connection".
   */
  function verifyNotificationsToken(token: string): NotificationsTokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: NOTIFICATIONS_TOKEN_ISSUER,
        algorithms: ['HS256'],
      });
      const parsed = NotificationsTokenPayloadSchema.safeParse(decoded);
      if (!parsed.success) {
        debug('notifications token payload failed schema validation:', parsed.error.issues);
        return null;
      }
      return parsed.data;
    } catch (err) {
      debug('notifications token verification failed:', (err as Error).message);
      return null;
    }
  }

  return {
    signNotificationsToken,
    verifyNotificationsToken,
    ttlSeconds: NOTIFICATIONS_TOKEN_TTL_SECONDS,
    issuer: NOTIFICATIONS_TOKEN_ISSUER,
  };
}

export type NotificationsTokenUtil = ReturnType<typeof buildNotificationsTokenUtil>;

export function createNotificationsTokenUtil(): NotificationsTokenUtil {
  if (cachedUtil === null) {
    cachedUtil = buildNotificationsTokenUtil();
  }
  return cachedUtil;
}
