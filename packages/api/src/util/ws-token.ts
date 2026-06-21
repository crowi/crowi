import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { WsTokenPayloadSchema, type WsTokenPayload } from '@crowi/api-contract';
import Debug from 'debug';

const debug = Debug('crowi:util:ws-token');

/**
 * Issuer claim used to sign / verify wsTokens. Distinct from the
 * access/refresh token issuer (`'crowi'`) so a leaked access-token
 * secret can never be replayed against Hocuspocus, and a leaked
 * wsToken secret can never be replayed against the HTTP JWT auth.
 */
const WS_TOKEN_ISSUER = 'crowi-collab';

/**
 * Lifetime of an issued wsToken. Hocuspocus refuses tokens whose `exp`
 * has passed; the browser provider uses `expiresAt` to proactively
 * refresh well before the WebSocket would otherwise be torn down.
 * Five minutes is short enough that a leaked token has limited blast
 * radius and long enough to cover typical reconnect storms.
 */
const WS_TOKEN_TTL_SECONDS = 300;

/**
 * Claims signed into the wsToken. The exported runtime schema lives in
 * `@crowi/api-contract` (`WsTokenPayloadSchema`) — Phase 3 Hocuspocus
 * code parses the verified payload through the same schema, so the
 * shape only has one source of truth.
 */
export interface WsTokenClaims {
  userId: string;
  pageId: string;
  readonly: boolean;
}

export interface SignWsTokenResult {
  /** Compact JWT string presented by the browser provider on connect. */
  token: string;
  /** ISO 8601 expiry timestamp, mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

/**
 * Resolve the WS_TOKEN_SECRET once per util instance:
 *
 *   - If `WS_TOKEN_SECRET` is set in the env, use it as-is. Operators
 *     are expected to share the same value across api + Hocuspocus +
 *     all multi-instance deployments (see RFC-0003 §Phase 9 docs).
 *   - Otherwise, generate a 32-byte random secret in-memory and log a
 *     warning. The process can still sign and verify its own tokens
 *     (closure-stable), but **process restarts invalidate all
 *     outstanding tokens** and **other instances cannot verify them**.
 *
 * The base64 encoding matches the existing `CROWI_ENCRYPTION_KEY`
 * convention so operators have a single mental model for "key
 * material" envs.
 */
const resolveWsTokenSecret = (): string => {
  if (isWsTokenSecretFromEnv()) {
    debug('WS_TOKEN_SECRET resolved from env');
    return process.env.WS_TOKEN_SECRET as string;
  }
  const generated = crypto.randomBytes(32).toString('base64');
  console.warn(
    '[crowi] WS_TOKEN_SECRET is not set — generated a random secret in-memory. ' +
      'Process restarts will invalidate all outstanding wsTokens, and multi-instance ' +
      'deployments will not be able to cross-verify tokens. Set WS_TOKEN_SECRET to ' +
      'a stable base64-encoded 32-byte value (`openssl rand -base64 32`) in production.',
  );
  return generated;
};

/**
 * Build a sign / verify pair bound to a single resolved secret. Crowi
 * boots once per process, so the closure-captured secret is stable for
 * the lifetime of the process; both the HTTP handler and the Hocuspocus
 * `onAuthenticate` hook use the same factory so sign / verify can never
 * drift apart in a single process.
 *
 * When `WS_TOKEN_SECRET` is unset, `resolveWsTokenSecret` generates a
 * fresh random secret per invocation. Two `createWsTokenUtil()` calls in
 * the same process would otherwise close over *different* random
 * secrets, which silently breaks HTTP-sign / Hocuspocus-verify in dev.
 * Memoise the factory result so every caller in the process shares one
 * closure (= one secret) regardless of when they call.
 *
 * The secret is read directly from `process.env.WS_TOKEN_SECRET` (not
 * via `crowi.getConfig()`) on purpose — out-of-band Hocuspocus
 * deployments read the same env, so env is the single source of truth
 * for cross-process secret distribution. This intentionally diverges
 * from `createJwtUtil(crowi)`, which reads from config to allow
 * admin-UI rotation.
 */
let cachedUtil: ReturnType<typeof buildWsTokenUtil> | null = null;

function buildWsTokenUtil() {
  const secret = resolveWsTokenSecret();

  /**
   * Sign a wsToken for the given claims. Returns the compact JWT plus
   * the absolute ISO expiry; callers serialise the timestamp into the
   * wire payload (`WsTokenResponseSchema.expiresAt`).
   */
  function signWsToken(claims: WsTokenClaims): SignWsTokenResult {
    // Pin `iat` ourselves so the response's `expiresAt` is **exactly**
    // the same instant as the JWT's `exp` claim — recomputing from
    // `Date.now()` after `jwt.sign(...)` would drift by ~1ms and made
    // proactive-refresh logic harder to reason about.
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + WS_TOKEN_TTL_SECONDS;
    const token = jwt.sign({ ...claims, iat, exp }, secret, {
      issuer: WS_TOKEN_ISSUER,
      algorithm: 'HS256',
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify a wsToken. Returns the validated payload, or `null` for any
   * failure (expired, bad signature, wrong issuer, malformed claims).
   * Callers must treat `null` as "reject the connection" — never log
   * the raw token (it is a bearer credential until `exp`).
   */
  function verifyWsToken(token: string): WsTokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: WS_TOKEN_ISSUER,
        algorithms: ['HS256'],
      });
      const parsed = WsTokenPayloadSchema.safeParse(decoded);
      if (!parsed.success) {
        debug('wsToken payload failed schema validation:', parsed.error.issues);
        return null;
      }
      return parsed.data;
    } catch (err) {
      debug('wsToken verification failed:', (err as Error).message);
      return null;
    }
  }

  return {
    signWsToken,
    verifyWsToken,
    ttlSeconds: WS_TOKEN_TTL_SECONDS,
    issuer: WS_TOKEN_ISSUER,
  };
}

export function createWsTokenUtil() {
  if (cachedUtil === null) {
    cachedUtil = buildWsTokenUtil();
  }
  return cachedUtil;
}

/**
 * Known non-functional placeholder values that must NOT be treated as a
 * real, configured secret (E1). A `.env` copied from an older template
 * shipped a fixed, world-known dev string; if a prod copy forgets to
 * replace it, every Crowi install would share the same signing key. We
 * reject these so they read as "not from env" — the per-process random
 * fallback kicks in (single-instance), and the multi-instance boot guard
 * still fails (forcing a real secret). Compared case-insensitively against
 * the trimmed value.
 */
const WS_TOKEN_SECRET_PLACEHOLDERS = new Set<string>([
  'dev-only-ws-token-secret-replace-in-production-0000=',
  'changeme',
  'change-me',
  'replace-me',
  'your-secret-here',
]);

/**
 * Whether `WS_TOKEN_SECRET` is a REAL configured secret (vs unset / empty /
 * a known placeholder, in which case we use the per-process random
 * fallback). editor-preview-reliability §4 / E1 uses this at boot to
 * fail-fast on a declared multi-instance deployment: a random fallback
 * secret can only be verified by the process that minted it, so a second
 * replica rejects every wsToken it didn't issue ("WebSocket closed before
 * the connection was established"). Rejecting placeholders here means a
 * forgotten template value can never satisfy the guard. A single source of
 * truth keeps the boot guard and `resolveWsTokenSecret` aligned on what
 * counts as "configured".
 */
export function isWsTokenSecretFromEnv(): boolean {
  const fromEnv = process.env.WS_TOKEN_SECRET;
  if (!fromEnv) return false;
  const trimmed = fromEnv.trim();
  if (trimmed.length === 0) return false;
  if (WS_TOKEN_SECRET_PLACEHOLDERS.has(trimmed.toLowerCase())) return false;
  return true;
}
