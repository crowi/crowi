/**
 * Rotation-reuse grace window for OAuth refresh tokens (RFC-0010 reuse
 * detection, spec §D-2).
 *
 * `hono/handlers/oauth.ts`'s refresh_token grant revokes the whole rotation
 * chain when an already-revoked token is presented again — the signature of
 * a stolen-token replay. That same signature also fires for two legitimate
 * concurrent refreshes of the same token: the loser presents the token the
 * winner just rotated away microseconds earlier. `isWithinReuseGrace` lets
 * the handler tell the two apart *by elapsed time alone* — a revoke that
 * happened moments ago is far more likely to be an in-flight race than a
 * captured token replayed after the fact.
 */

/** Default grace window (ms). Generous for a concurrent-request race, short for an attacker to land inside. */
const DEFAULT_GRACE_MS = 60_000;

/**
 * Sanity ceiling on `OAUTH_REFRESH_REUSE_GRACE_MS`. The grace window
 * suppresses reuse-detection's chain revocation, so an unbounded value would
 * let a misconfigured deployment silently widen the stolen-token replay
 * window far past what any real request race needs.
 */
const MAX_GRACE_MS = 5 * 60 * 1000;

/** Matches only a plain non-negative integer literal — no exponents, no trailing units, no leading/trailing whitespace. */
const STRICT_NONNEGATIVE_INT = /^\d+$/;

/**
 * Resolve the configured grace window. Non-numeric, malformed (e.g. `"1e3"`,
 * `"60000ms"`, `""`), or unset falls back to the default. Negative values
 * also fall back to the default — a negative grace has no sensible meaning.
 * `0` is a valid, meaningful value distinct from "unset": it disables the
 * grace entirely, restoring the pre-existing unconditional chain revocation.
 * Positive values are clamped to {@link MAX_GRACE_MS}.
 */
function resolveGraceMs(): number {
  const raw = process.env.OAUTH_REFRESH_REUSE_GRACE_MS;
  if (raw === undefined || !STRICT_NONNEGATIVE_INT.test(raw)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.min(Number.parseInt(raw, 10), MAX_GRACE_MS);
}

/**
 * The grace window in effect for this process, resolved once from
 * `OAUTH_REFRESH_REUSE_GRACE_MS` at import time (matching the adjacent
 * `ACCESS_TOKEN_TTL_SEC` / `REFRESH_TOKEN_TTL_MS` pattern in
 * `hono/handlers/oauth.ts`).
 */
export const OAUTH_REFRESH_REUSE_GRACE_MS = resolveGraceMs();

/**
 * Whether `revokedAt` is recent enough that a replay of the token it belongs
 * to should be treated as a benign concurrent-request race rather than a
 * stolen-token replay. `now` defaults to the current time; tests pass it
 * explicitly to pin the boundary.
 *
 * Elapsed time is clamped to a minimum of 0 before the comparison. Without
 * this, cross-replica clock skew can make `revokedAt` appear to be in the
 * future (negative elapsed), which would make the comparison trivially true
 * for ANY `OAUTH_REFRESH_REUSE_GRACE_MS > 0` regardless of how long ago the
 * revoke actually happened — the opposite of what a small skew should do.
 * The clamp also guarantees `OAUTH_REFRESH_REUSE_GRACE_MS === 0` always
 * evaluates to `false` (0 < 0 is never true), even under clock skew that
 * makes `revokedAt` appear future-dated.
 */
export function isWithinReuseGrace(revokedAt: Date, now: Date = new Date()): boolean {
  const elapsedMs = Math.max(now.getTime() - revokedAt.getTime(), 0);
  return elapsedMs < OAUTH_REFRESH_REUSE_GRACE_MS;
}
