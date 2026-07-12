import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import Debug from 'debug';
import type { ZodType } from 'zod';

const debug = Debug('crowi:util:signed-token-factory');

/**
 * Shared factory behind every short-lived signed token Crowi mints:
 * collab wsTokens (`util/ws-token.ts`), presence tokens
 * (`util/presence-token.ts`), notifications tokens
 * (`util/notifications-token.ts`), and mail tokens embedded in
 * transactional email links (`util/mail-token.ts`).
 *
 * All four used to independently re-implement the same
 * "issuer const → TTL const → env-based secret resolver (with a random
 * in-memory fallback + warn when unset) → `jwt.sign` / `jwt.verify` +
 * schema `safeParse`" structure. That duplication let the secret
 * resolvers drift: `ws-token.ts` rejected known placeholder values
 * (`changeme` etc, see `SIGNED_TOKEN_SECRET_PLACEHOLDERS` below) so a
 * forgotten `.env` template value could never be used to sign a real
 * token, but the other three did not — most importantly `mail-token.ts`,
 * which signs password-reset links. A world-known placeholder secret
 * left in a production `.env` would let anyone forge a valid
 * `purpose: 'reset'` token for any user. Consolidating secret
 * resolution (placeholder rejection included) into this single factory
 * means every channel gets the same protection by construction — there
 * is no second resolver to forget to update.
 *
 * The memoization strategy also used to be split in two: `ws-token.ts` /
 * `presence-token.ts` memoized the *whole util instance* (secret pinned
 * at first construction), while `notifications-token.ts` /
 * `mail-token.ts` memoized *only the random fallback secret* and
 * rebuilt the util (re-reading the env) on every call. The latter is
 * what fixed a real production incident (commit `95f7862d`, "stop
 * notifications WebSocket reconnect storm when WS_TOKEN_SECRET is
 * unset"): a mint request and a later verify (almost always a different
 * `createXTokenUtil()` call) must resolve to the *same* secret even
 * when `WS_TOKEN_SECRET` is unset, otherwise every handshake fails and
 * the client retries in an unthrottled loop. This factory standardises
 * on that fallback-secret-only strategy so the fix — and any future
 * one — applies to all four channels at once.
 */

/** Default env var every channel reads unless it opts into another one. */
const DEFAULT_SECRET_ENV_VAR = 'WS_TOKEN_SECRET';

/**
 * Known non-functional placeholder values that must NOT be treated as a
 * real, configured secret. A `.env` copied from an older template
 * shipped a fixed, world-known dev string; if a prod copy forgets to
 * replace it, every Crowi install would share the same signing key —
 * and, worst case, a third party who knows the placeholder could forge
 * a password-reset mail token for any user. Rejecting these makes them
 * read as "not from env": the per-process random fallback kicks in
 * (safe for a single instance), and the multi-instance boot guard
 * (`collab/attach.ts:assertWsTokenSecretForMultiInstance`, via
 * `isWsTokenSecretFromEnv`) still fails, forcing a real secret. Compared
 * case-insensitively against the trimmed value.
 */
const SIGNED_TOKEN_SECRET_PLACEHOLDERS = new Set<string>([
  'dev-only-ws-token-secret-replace-in-production-0000=',
  'changeme',
  'change-me',
  'replace-me',
  'your-secret-here',
]);

/**
 * Whether `process.env[envVarName]` holds a REAL configured secret (vs
 * unset / empty / a known placeholder — in which case callers fall back
 * to the per-process random secret). `ws-token.ts` re-exports this
 * (bound to `WS_TOKEN_SECRET`) as `isWsTokenSecretFromEnv`, which
 * `collab/attach.ts`'s multi-instance boot guard depends on: a random
 * fallback secret can only be verified by the process that minted it,
 * so a second replica would reject every token it didn't issue itself.
 * Rejecting placeholders here means a forgotten template value can
 * never satisfy that guard.
 */
export function isSignedTokenSecretConfiguredFromEnv(envVarName: string): boolean {
  const fromEnv = process.env[envVarName];
  if (!fromEnv) return false;
  const trimmed = fromEnv.trim();
  if (trimmed.length === 0) return false;
  if (isKnownSignedTokenSecretPlaceholder(trimmed)) return false;
  return true;
}

/**
 * Whether `trimmed` (already trimmed, compared case-insensitively — same as
 * {@link isSignedTokenSecretConfiguredFromEnv}) is one of the known
 * non-functional placeholder values above. Exported so
 * `util/env-schema.ts`'s `WS_TOKEN_SECRET` minimum-length check can exempt a
 * value this factory already treats as "not configured" (random fallback +
 * its own warning), instead of keeping a second, driftable copy of the
 * placeholder list.
 */
export function isKnownSignedTokenSecretPlaceholder(trimmed: string): boolean {
  return SIGNED_TOKEN_SECRET_PLACEHOLDERS.has(trimmed.toLowerCase());
}

/**
 * Process-wide random fallback secrets, keyed by env var name and
 * generated at most once per key. Every channel defaults to the same
 * `WS_TOKEN_SECRET` env var, so in practice this map holds a single
 * entry shared by ws / presence / notifications / mail tokens — cross-
 * channel replay is still prevented by the distinct `issuer` each
 * channel signs with, not by secret isolation.
 *
 * Must NOT be regenerated per call: a token is typically minted by one
 * request and verified by a later, separate one — almost always through
 * a different `createSignedTokenUtil()` call. Regenerating a random
 * secret on every call would mean mint and verify (almost) never agree
 * whenever the env var is unset, and every verification would fail.
 */
const fallbackSecretsByEnvVar = new Map<string, string>();

/**
 * Resolve the signing secret for `envVarName`. Reads `process.env`
 * fresh on every call — this module is imported transitively before
 * `app.ts` runs `dotenv.config()`, and a test may mutate the env
 * between two `createSignedTokenUtil()` calls, so the env is the single
 * source of truth read at construction time rather than cached. Only
 * the random fallback (used when the env var is unset / a placeholder)
 * is memoized, and only once per `envVarName` — see
 * `fallbackSecretsByEnvVar` above. The "secret missing" warning fires
 * at most once per `envVarName` per process (silenced under tests, same
 * as the pre-consolidation per-channel warnings).
 */
function resolveSignedTokenSecret(envVarName: string): string {
  if (isSignedTokenSecretConfiguredFromEnv(envVarName)) {
    debug('%s resolved from env', envVarName);
    return process.env[envVarName] as string;
  }
  const cached = fallbackSecretsByEnvVar.get(envVarName);
  if (cached) return cached;

  const generated = crypto.randomBytes(32).toString('base64');
  fallbackSecretsByEnvVar.set(envVarName, generated);
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      `[crowi] ${envVarName} is not set (or is a known placeholder value) — signed tokens will be issued with ` +
        'a random in-memory secret. Process restarts will invalidate outstanding tokens, and multi-instance ' +
        `deployments will not be able to cross-verify them. Set ${envVarName} to a stable base64-encoded ` +
        '32-byte value (`openssl rand -base64 32`) in production.',
    );
  }
  return generated;
}

/** Compact JWT plus its absolute expiry, returned by every `sign()`. */
export interface SignedTokenResult {
  /** Compact JWT string. */
  token: string;
  /** ISO 8601 expiry timestamp, mirrors `exp * 1000` as a Date. */
  expiresAt: Date;
}

export interface SignedTokenUtil<TClaims extends object, TPayload> {
  /**
   * Sign `claims` into a compact JWT. `iat` is pinned before `jwt.sign`
   * runs so the returned `expiresAt` is **exactly** the same instant as
   * the JWT's `exp` claim.
   */
  sign(claims: TClaims): SignedTokenResult;
  /**
   * Verify a token. Returns the validated payload, or `null` for any
   * failure (expired, bad signature, wrong issuer, malformed claims).
   * Callers must treat `null` as "reject" — this never throws.
   */
  verify(token: string): TPayload | null;
  /** The `iss` claim this util signs with / requires on verify. */
  issuer: string;
}

export interface CreateSignedTokenUtilConfig<TClaims extends object, TPayload> {
  /**
   * `iss` claim signed / required on verify. Each channel uses a
   * distinct issuer so a token leaked from one channel is never
   * replayable against another, even though they share the same
   * `WS_TOKEN_SECRET` key material by default.
   */
  issuer: string;
  /**
   * Token lifetime in seconds, either fixed or derived from the claims
   * being signed (`mail-token.ts` uses a per-`purpose` TTL map).
   */
  ttlSeconds: number | ((claims: TClaims) => number);
  /** Runtime schema the decoded payload must satisfy on verify. */
  payloadSchema: ZodType<TPayload>;
  /** Env var the secret is read from. Defaults to `WS_TOKEN_SECRET`. */
  secretEnvVar?: string;
}

export function createSignedTokenUtil<TClaims extends object, TPayload>(
  config: CreateSignedTokenUtilConfig<TClaims, TPayload>,
): SignedTokenUtil<TClaims, TPayload> {
  const { issuer, ttlSeconds, payloadSchema, secretEnvVar = DEFAULT_SECRET_ENV_VAR } = config;
  const secret = resolveSignedTokenSecret(secretEnvVar);

  function sign(claims: TClaims): SignedTokenResult {
    const iat = Math.floor(Date.now() / 1000);
    const ttl = typeof ttlSeconds === 'function' ? ttlSeconds(claims) : ttlSeconds;
    const exp = iat + ttl;
    const token = jwt.sign({ ...claims, iat, exp }, secret, {
      issuer,
      algorithm: 'HS256',
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  function verify(token: string): TPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer,
        algorithms: ['HS256'],
      });
      const parsed = payloadSchema.safeParse(decoded);
      if (!parsed.success) {
        debug('%s token payload failed schema validation:', issuer, parsed.error.issues);
        return null;
      }
      return parsed.data;
    } catch (err) {
      debug('%s token verification failed:', issuer, (err as Error).message);
      return null;
    }
  }

  return { sign, verify, issuer };
}
