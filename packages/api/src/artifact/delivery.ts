/**
 * Pure module: no Hono Context, DB, or HTTP access, so it can be imported
 * from any process without pulling in Crowi's full dependency graph.
 */
import crypto from 'node:crypto';

import { timingSafeEqualStrings } from 'src/util/federated-auth-state';
import { resolveSignedTokenSecret } from 'src/util/signed-token-factory';

// Distinct info string prevents key collision with oauth-state HMAC,
// allowing both to coexist from the same signing secret.
export const ARTIFACT_TOKEN_HKDF_INFO = 'crowi:artifact-delivery-hmac:v1';

export const ARTIFACT_TOKEN_TTL_SECONDS = 60;

// userId (u) included in payload for audit trails and future revocation,
// but never checked during verification since the artifact origin has no session.
export interface ArtifactTokenPayload {
  readonly p: string;
  readonly r: string;
  readonly u: string;
  readonly e: number; // epoch milliseconds
}

export type ArtifactUrlErrorReason = 'NOT_AN_ARTIFACT' | 'ARTIFACT_DELIVERY_NOT_CONFIGURED';

// Fixed messages only; token and body content must not appear in errors.
export const ARTIFACT_URL_ERROR_MESSAGES: Readonly<Record<ArtifactUrlErrorReason, string>> = {
  NOT_AN_ARTIFACT: 'This revision is not an HTML artifact.',
  ARTIFACT_DELIVERY_NOT_CONFIGURED: 'HTML artifact delivery is not configured on this server.',
};

/**
 * Same HKDF-SHA-256 construction as `federated-auth-state.ts#deriveStateHmacKey`,
 * distinguished only by `info`, so both derive independent keys from one app secret.
 */
export function deriveArtifactTokenKey(secret: string): Buffer {
  const okm = crypto.hkdfSync('sha256', secret, Buffer.alloc(0), ARTIFACT_TOKEN_HKDF_INFO, 32);
  return Buffer.from(okm);
}

/**
 * Resolves the token-signing key from the same `SECRET_TOKEN` (env, required
 * at boot) that every other JWT/HMAC channel signs with —
 * `util/signed-token-factory.ts#resolveSignedTokenSecret`. That resolver
 * never returns an unusable value in a normally booted process (an unset or
 * placeholder `SECRET_TOKEN` aborts boot first), so this always derives a
 * real key.
 */
export function resolveArtifactTokenKey(): Buffer {
  return deriveArtifactTokenKey(resolveSignedTokenSecret());
}

/**
 * The wire format's 2 segments are `base64url` alphabet only (no `+`, `/`,
 * or padding `=`). Node's `Buffer.from(x, 'base64url')` never throws on an
 * out-of-alphabet character, so without this check a token containing one
 * could still decode (and, in rare cases, still MAC-match) instead of
 * failing closed the way verification requires.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The payload's field set is exactly these 4 keys, no more, no less. */
const ARTIFACT_TOKEN_PAYLOAD_KEYS = ['p', 'r', 'u', 'e'] as const;

/**
 * Reconstructs a plain 4-field object rather than serializing `payload`
 * as-is — `payload`'s static type can't stop a caller from passing a
 * structurally-wider object (e.g. one built by spreading extra fields onto
 * an `ArtifactTokenPayload`), and this function has no way to reject that at
 * the type level. Serializing exactly these 4 keys guarantees the minted
 * payload always matches what `isArtifactTokenPayload` accepts, regardless
 * of what the caller's object happens to carry alongside it.
 */
function canonicalArtifactTokenPayload(payload: ArtifactTokenPayload): ArtifactTokenPayload {
  return { p: payload.p, r: payload.r, u: payload.u, e: payload.e };
}

/** Wire format: `base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(base64url(JSON(payload))))`, the same shape `federated-auth-state.ts`'s state cookie uses. */
export function mintArtifactToken(key: Buffer, payload: ArtifactTokenPayload): string {
  const payloadPart = Buffer.from(JSON.stringify(canonicalArtifactTokenPayload(payload))).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(payloadPart).digest('base64url');
  return `${payloadPart}.${mac}`;
}

/**
 * The payload's field set is fixed at exactly 4 keys. A shape check that
 * only inspects `p`/`r`/`u`/`e`'s types (accepting anything alongside them)
 * would still MAC-verify a payload with an extra field a future mint-side
 * version added, since the MAC covers bytes this verifier never re-derives
 * from a canonical re-serialization — reject on key-count mismatch instead
 * of trusting the type check alone.
 */
function isArtifactTokenPayload(value: unknown): value is ArtifactTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== ARTIFACT_TOKEN_PAYLOAD_KEYS.length) return false;
  if (!ARTIFACT_TOKEN_PAYLOAD_KEYS.every((key) => key in v)) return false;
  return typeof v.p === 'string' && typeof v.r === 'string' && typeof v.u === 'string' && typeof v.e === 'number' && Number.isFinite(v.e);
}

/**
 * `Buffer#toString('utf8')` silently substitutes U+FFFD for invalid byte
 * sequences instead of failing, so a payload segment containing malformed
 * UTF-8 would still decode to *some* string and could, in principle, still
 * parse as JSON. Fatal decoding makes the shape check below reject it
 * instead of laundering it through `JSON.parse`. `ignoreBOM: true` keeps a
 * leading BOM in the decoded output (rather than stripping it) so a payload
 * prefixed with one still fails `JSON.parse` the same way
 * `Buffer#toString('utf8')` did — fatal decoding must narrow what verifies,
 * not incidentally widen it.
 */
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Verifies in this exact order: shape, then MAC, then expiry, then revision
 * id, then page id. Shape and MAC must both hold before any field is
 * trusted, since a forged or malformed token could otherwise smuggle a
 * crafted `p`/`r`/`e` past the later comparisons. Never throws — every
 * failure, including a payload that doesn't even parse as the expected JSON
 * shape, is a `null` return.
 */
export function verifyArtifactToken(
  key: Buffer,
  token: string,
  expected: Readonly<{ pageId: string; revisionId: string }>,
  nowMs: number,
): ArtifactTokenPayload | null {
  // shape
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadPart, mac] = parts;
  if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(mac)) return null;

  // mac
  const expectedMac = crypto.createHmac('sha256', key).update(payloadPart).digest('base64url');
  if (!timingSafeEqualStrings(mac, expectedMac)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(FATAL_UTF8_DECODER.decode(Buffer.from(payloadPart, 'base64url')));
  } catch {
    return null;
  }
  if (!isArtifactTokenPayload(decoded)) return null;

  // expiry
  if (!(nowMs < decoded.e)) return null;
  // revision id
  if (decoded.r !== expected.revisionId) return null;
  // page id
  if (decoded.p !== expected.pageId) return null;

  return decoded;
}

/**
 * Used for the download route's `Content-Disposition` filename — the Page
 * path's last `/`-delimited segment with `.html` appended. A portal path
 * ends in `/` (its last split segment is empty) and the root path splits to
 * all-empty segments, so both fall back to `artifact` rather than naming the
 * file after a doubled or missing slash.
 */
export function artifactDownloadFilename(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  return `${last.length > 0 ? last : 'artifact'}.html`;
}
