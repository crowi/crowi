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
 * Process-wide random fallback secret, generated at most once. Must NOT
 * be re-generated per call: a notifications token is minted by one
 * request (`GET /notifications/token`) and verified by a later, separate
 * WebSocket upgrade — almost always through a different
 * `createNotificationsTokenUtil()` instance. Regenerating a random secret
 * on every call (the previous implementation) meant mint and verify
 * practically never agreed whenever `WS_TOKEN_SECRET` was unset, so every
 * handshake was rejected with `WS_CLOSE.INVALID_TOKEN` (4401) — the
 * client then looped invalidating its token query as fast as it could,
 * producing an unthrottled reconnect storm. Mirrors `mail-token.ts`'s
 * `fallbackSecret` (also `presence-token.ts` / `ws-token.ts`, which
 * memoize the whole util instead — either shape fixes the same class of
 * bug; this one keeps reading `WS_TOKEN_SECRET` fresh per call, per the
 * boot/test-ordering rationale below).
 */
let fallbackSecret: string | null = null;

/**
 * Resolve the signing secret. Reads `WS_TOKEN_SECRET` per call so a test
 * that mutates the env between imports / util constructions still picks
 * up the latest value; the random fallback (used only when the env var
 * is unset) is memoized process-wide so every caller agrees on it.
 *
 * The "secret missing" warning is emitted here (lazily, on first
 * resolution) rather than at module-load time: this module is imported
 * transitively before `app.ts` runs `dotenv.config()`, so a load-time
 * `process.env` read fires a false warning even when `.env` defines
 * `WS_TOKEN_SECRET`. Memoizing `fallbackSecret` keeps the warn to once
 * per process. Silenced under tests.
 */
const resolveNotificationsTokenSecret = (): string => {
  const fromEnv = process.env.WS_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    debug('notifications token secret resolved from WS_TOKEN_SECRET');
    return fromEnv;
  }
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('base64');
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[crowi] WS_TOKEN_SECRET is not set — notifications tokens will be signed with a random in-memory secret. ' +
          'Process restarts will invalidate outstanding notifications tokens, and multi-instance deployments ' +
          'will not be able to cross-verify them. Set WS_TOKEN_SECRET to a stable base64-encoded 32-byte ' +
          'value (`openssl rand -base64 32`) in production.',
      );
    }
  }
  return fallbackSecret;
};

/**
 * Build a sign / verify pair bound to a freshly resolved secret. Each
 * `createNotificationsTokenUtil()` call returns a new instance — the
 * util's surface (sign / verify) is cheap (a single jsonwebtoken call)
 * so memoising is unnecessary, and the previous cached-singleton
 * implementation pinned the secret to whatever env state existed at the
 * first call (a problem for test / boot ordering: a `WS_TOKEN_SECRET`
 * set after first util construction would be ignored).
 */
function buildNotificationsTokenUtil() {
  const secret = resolveNotificationsTokenSecret();

  /**
   * Sign a notifications token for the given claims. Returns the
   * compact JWT plus the absolute expiry; the handler serialises the
   * timestamp into `NotificationsTokenResponseSchema.expiresAt`.
   *
   * A fresh `jti` (random UUID) is mixed into the payload so two
   * tokens minted within the same second are byte-different. The
   * browser uses the token string as a react `useEffect` dependency
   * (it dials the WebSocket whenever the token changes) — without a
   * `jti`, the iat/exp pair is identical and the dep stays stable, so
   * a re-mint at the same second does not trigger the effect. The
   * verifier ignores `jti`, keeping the token stateless.
   */
  function signNotificationsToken(claims: NotificationsTokenClaims): SignNotificationsTokenResult {
    // Pin `iat` ourselves so the response's `expiresAt` is exactly the
    // same instant as the JWT's `exp` claim (same rationale as the
    // collab / presence token utils).
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + NOTIFICATIONS_TOKEN_TTL_SECONDS;
    const jti = crypto.randomUUID();
    const token = jwt.sign({ ...claims, jti, iat, exp }, secret, {
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
  return buildNotificationsTokenUtil();
}
