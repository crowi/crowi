import { randomBytes } from 'node:crypto';

/**
 * RFC 4648 §5 base64url encoding without padding. Kept file-local (a
 * near-duplicate of `oauth.ts`'s own `base64url`) rather than exported and
 * shared: PKCE verifiers and idempotency keys serve unrelated purposes, and
 * a change motivated by one should not risk the other.
 */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a fresh Idempotency-Key for one write operation. 16 random bytes
 * base64url-encode to 22 characters, comfortably inside the server's
 * `IDEMPOTENCY_KEY_PATTERN` (`/^[A-Za-z0-9_-]{16,128}$/`).
 *
 * Callers generate exactly one key per logical operation and pass it via
 * `AuthedFetchOptions.headers` — this module never calls `authedFetch`
 * itself, since only the caller knows which requests belong to the same
 * operation.
 */
export function newIdempotencyKey(): string {
  return base64url(randomBytes(16));
}
