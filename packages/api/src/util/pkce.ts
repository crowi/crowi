import crypto from 'node:crypto';

/**
 * RFC 7636 §4.2 S256 code_challenge: `base64url(sha256(code_verifier))`.
 * Shared by `verifyPkceS256` below (token-time verification) and
 * `hono/handlers/federated-auth.ts` (authorize-time generation) — same
 * formula, one place.
 */
export function computePkceCodeChallengeS256(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * RFC 7636 PKCE — S256 code-challenge verification.
 *
 * The client sends `code_challenge = base64url(sha256(code_verifier))` at
 * authorize time and the raw `code_verifier` at token time. We recompute
 * the challenge from the verifier and compare. Only S256 is supported
 * (RFC-0010 §Security — the `plain` method is rejected upstream so it is
 * not handled here).
 *
 * The comparison is constant-time (`crypto.timingSafeEqual`) to avoid
 * leaking how many leading bytes matched.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = computePkceCodeChallengeS256(codeVerifier);
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  // timingSafeEqual throws on length mismatch — a length difference is
  // already a definitive non-match, so short-circuit.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
