import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack signs every inbound request (Events API / slash / interactivity)
 * with `X-Slack-Signature` over the raw body. We MUST verify it before
 * trusting any payload, because the `/events` route is mounted `public`
 * (Crowi-auth bypassed) — the Slack signature is the only authentication
 * the endpoint has (RFC-0013 §8).
 *
 * Anything older than this many seconds is rejected as a replay even if
 * the HMAC matches. Slack itself recommends a 5-minute window.
 */
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

const SIGNATURE_VERSION = 'v0';

export interface VerifySlackSignatureInput {
  /** The plugin's configured Slack signing secret. */
  signingSecret: string;
  /** Value of the `X-Slack-Request-Timestamp` header (unix seconds, as a string). */
  timestamp: string | null | undefined;
  /** The exact raw request body bytes (`c.req.text()` — never re-serialized). */
  rawBody: string;
  /** Value of the `X-Slack-Signature` header (`v0=<hex>`). */
  signature: string | null | undefined;
  /**
   * Override "now" (unix seconds) for tests; defaults to the wall clock.
   * Used to drive the ±5-minute replay-guard assertions deterministically.
   */
  nowSeconds?: number;
}

export type VerifySlackSignatureResult = { ok: true } | { ok: false; reason: 'missing-headers' | 'expired' | 'mismatch' | 'unconfigured' };

/**
 * Verify a Slack request signature.
 *
 * Computes `HMAC-SHA256` over `v0:{timestamp}:{rawBody}` keyed by the
 * signing secret, compares it against `X-Slack-Signature` in
 * constant time, and rejects requests whose timestamp is outside the
 * ±5-minute replay window. A pure function so the dispatcher stays thin
 * and the rule is unit-testable without HTTP.
 */
export function verifySlackSignature(input: VerifySlackSignatureInput): VerifySlackSignatureResult {
  const { signingSecret, timestamp, rawBody, signature } = input;

  if (!signingSecret) {
    return { ok: false, reason: 'unconfigured' };
  }
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing-headers' };
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'missing-headers' };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }

  const base = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SIGNATURE_VERSION}=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  if (!constantTimeEquals(expected, signature)) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

/**
 * Constant-time string comparison. `timingSafeEqual` throws when the
 * buffers differ in length, so we length-check first (which already
 * leaks nothing useful — Slack signatures are fixed length) and fall
 * through to the timing-safe compare for equal-length inputs.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
