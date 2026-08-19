/**
 * RFC-0014 phase 1 §"設計の主な判断" 2-3 — federated (OAuth2/OIDC) sign-in
 * state cookie, PKCE, and sender-constrained handoff proof primitives.
 *
 * Everything here is Hono-`Context`-free (plain strings/objects in,
 * plain strings/booleans out) so it is directly unit-testable and so the
 * Hono handler (`hono/handlers/federated-auth.ts`) owns the actual
 * `Set-Cookie` / `Cookie` header plumbing via `hono/cookie`'s
 * `setCookie`/`getCookie`/`deleteCookie` — this module only produces /
 * consumes the opaque cookie VALUE.
 *
 * State cookie wire format: `base64url(JSON(payload)) + '.' + base64url(
 * HMAC-SHA256(payload))`. The HMAC key is derived via HKDF-SHA-256
 * (`info = "crowi:oauth-state-hmac:v1"`) from the SAME secret source
 * `util/jwt.ts#createJwtUtil` signs JWTs with (`app:secret` / `SECRET_TOKEN`
 * / the same `'your-secret-key'` fallback) — but HKDF derives a distinct
 * 32-byte key, so this cookie's HMAC key is never the JWT signing key
 * itself (design decision: a compromise of one must not cross-apply to the
 * other).
 */

import type { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';

import type Crowi from 'src/crowi';

/** `Max-Age` for the state cookie — 300 seconds (RFC-0014 phase 1 §"契約・不変条件"). Also the sign-in-state / link-state TTL used throughout this module. */
const STATE_TTL_MS = 5 * 60 * 1000;

const STATE_HKDF_INFO = 'crowi:oauth-state-hmac:v1';

/**
 * RFC-0014 phase 1 §"契約・不変条件" — the issued cookie VALUE (not merely the
 * decoded JSON payload) must stay under 4KB, the de-facto browser Set-Cookie
 * limit. `ContinuePathSchema` (`api-contract/src/contracts/federated-auth.ts`)
 * already bounds the one variable-length, externally-controlled field
 * (`continue`) with plenty of headroom under this, so `issue()` throwing here
 * should never be reachable in normal operation — this is a defensive
 * backstop against a future payload field silently pushing the cookie over
 * the limit, not the primary enforcement point.
 */
const MAX_STATE_COOKIE_VALUE_BYTES = 4096;

/** Public path the state cookie is scoped to — every federated-auth route lives under this prefix on the wire (`/api` is stripped internally, see `hono/path-rewrite.ts`). */
const STATE_COOKIE_PATH = '/api/auth/providers';

const STATE_COOKIE_NAME = 'crowi.oauthState';

/**
 * The link state's
 * reserved namespace. Every `crowilnk_`-prefixed sign-in `state` value is
 * impossible by construction (`generateSignInStateValue()` rejection-samples
 * around it), so the callback can branch on this prefix ALONE to decide
 * "link flow" vs "sign-in flow" before touching the fixed `crowi.oauthState`
 * cookie at all — a link-namespace callback must never read/delete the
 * unrelated sign-in cookie.
 */
export const LINK_STATE_VALUE_PREFIX = 'crowilnk_';

/** 25 random bytes -> 34-char base64url; `LINK_STATE_VALUE_PREFIX` (9 chars) + 34 = 43 total, matching the API contract's completion-code-adjacent length convention. */
const LINK_STATE_RANDOM_BYTES = 25;

/** `crowilnk_` + 34 base64url chars = 43. */
export const LINK_STATE_VALUE_PATTERN = /^crowilnk_[A-Za-z0-9_-]{34}$/;

/** link state cookie name prefix; the full cookie name is `${LINK_STATE_COOKIE_PREFIX}${state}` (see `linkCookieNameFor`). */
export const LINK_STATE_COOKIE_PREFIX = 'crowi.oauthLinkState.';

/** Same path as the sign-in state cookie — every federated-auth route lives under this prefix. */
export const LINK_STATE_COOKIE_PATH = '/api/auth/providers';

/** per-cookie value ceiling (4096 bytes allowed, 4097+ rejected). */
export const MAX_LINK_STATE_COOKIE_VALUE_BYTES = 4096;

/** max LIVE link-flow cookie count a single `link-start` admits, fresh cookie included. */
export const MAX_LINK_FLOW_COOKIE_COUNT = 5;

/** projected `Cookie` request-header byte budget (11 KiB) a `link-start` prunes toward. */
export const MAX_LINK_COOKIE_HEADER_BYTES = 11 * 1024;

/**
 * The largest a
 * single link-flow `name=value` pair can ever be: the cookie NAME is fixed-
 * length (`LINK_STATE_COOKIE_PREFIX` + the fixed 43-char state), and the
 * VALUE is capped at {@link MAX_LINK_STATE_COOKIE_VALUE_BYTES}. Used both as
 * the prune target's race-window reserve ({@link LINK_COOKIE_HEADER_RACE_RESERVE_BYTES})
 * and, indirectly, to size that reserve without hardcoding the same number twice.
 */
export const MAX_LINK_COOKIE_PAIR_BYTES =
  Buffer.byteLength(LINK_STATE_COOKIE_PREFIX, 'utf8') + LINK_STATE_VALUE_PREFIX.length + 34 + 1 /* '=' */ + MAX_LINK_STATE_COOKIE_VALUE_BYTES;

/**
 * Reserved so a
 * SECOND concurrent `link-start` response racing to set its own cookie on
 * the same connection cannot itself push the aggregate `Cookie` header (as
 * later replayed by the browser) past Node's default `http.maxHeaderSize`
 * (16 KiB). This is best-effort, not a guarantee: two concurrent
 * `link-start` requests each read their own snapshot of the incoming
 * `Cookie` header, so admission can't see the OTHER request's fresh cookie
 * before it lands — a residual risk this reserve narrows but cannot close.
 */
export const LINK_COOKIE_HEADER_RACE_RESERVE_BYTES = MAX_LINK_COOKIE_PAIR_BYTES;

/** Node's default `http.maxHeaderSize` (16 KiB) — see design decision 7. Not itself configurable here; this is the ceiling admission must stay under. */
const NODE_DEFAULT_MAX_HEADER_SIZE_BYTES = 16 * 1024;

/**
 * Decoded state-cookie payload. `expiresAt` is an absolute epoch-ms
 * timestamp (not a TTL) so `verify()` can reject an expired cookie without
 * needing to know when it was issued.
 */
export interface FederatedAuthState {
  /** Random opaque value echoed as the IdP `state` query parameter. */
  state: string;
  /** Driver name this flow was started for — callback rejects a mismatch. */
  provider: string;
  /** Absolute epoch-ms expiry. */
  expiresAt: number;
  /** Local path (`/…`, never `//…`) validated at `/start`. */
  continuePath: string;
  /** RFC 7636 PKCE verifier — present whenever the driver requires/declares PKCE. */
  codeVerifier?: string;
  /** OIDC nonce — present for `oidc` kind drivers only. */
  oidcNonce?: string;
  /** RFC 7638 JWK thumbprint of the sender's P-256 public key — binds the eventual handoff code to this browser's key pair. */
  handoffJkt: string;
}

/**
 * The flow-specific
 * link-state cookie payload. Deliberately NOT a variant merged into
 * `FederatedAuthState` (no `linkToUserId`/`linkAuthVersion` optional fields
 * on the sign-in shape any more — see design decision 5): a link flow lives
 * in its own cookie, under its own reserved `state` namespace
 * (`LINK_STATE_VALUE_PREFIX`), verified with its own `verifyLink`.
 *
 * `userId`/`authVersion` are captured from the SERVER-resolved session at
 * `link-start` time (never a query parameter, never the IdP profile) — this
 * is what a stolen/copied authorization URL cannot repoint at a different
 * account: the target lives inside the HMAC-signed cookie the copying
 * browser never has (AC-4).
 */
export interface FederatedLinkState {
  flow: 'link';
  state: string;
  provider: string;
  userId: string;
  /** `User.authVersion` at link-start time — re-checked once more, fresh, right before the confirmation POST inserts an identity (design decision 13). */
  authVersion: number;
  expiresAt: number;
  codeVerifier?: string;
  oidcNonce?: string;
}

/** `planLinkCookiePrune`'s result — see that method's doc comment. */
export interface LinkCookiePrunePlan {
  /** Link-flow cookie NAMEs the handler must `deleteCookie(...)` (same `Path`) before/instead of setting the fresh one. */
  expireCookieNames: string[];
  /** The projected `Cookie` request-header byte length AFTER applying `expireCookieNames` and adding the fresh pair — what a subsequent callback request would present. */
  projectedCookieHeaderBytes: number;
}

/**
 * Thrown by
 * `issueLink()` when the serialized cookie VALUE exceeds
 * {@link MAX_LINK_STATE_COOKIE_VALUE_BYTES}. Deliberately carries NO
 * value/provider/byte-count fields — the handler maps this to the existing
 * 400 `INVALID_REQUEST` via `instanceof` alone, and nothing about the
 * oversized input belongs in a thrown error a generic catch/log path might
 * inspect.
 */
export class FederatedLinkStateCookieTooLargeError extends Error {
  constructor() {
    super('federated-auth-state: issued link state cookie value exceeds the byte limit');
    this.name = 'FederatedLinkStateCookieTooLargeError';
  }
}

/**
 * Thrown by
 * `planLinkCookiePrune()` when, even after pruning every prunable link-flow
 * cookie, the projected `Cookie` header still cannot fit under
 * {@link MAX_LINK_COOKIE_HEADER_BYTES} or leave room for
 * {@link LINK_COOKIE_HEADER_RACE_RESERVE_BYTES} under Node's default
 * `http.maxHeaderSize`. The handler maps this to the same 400
 * `INVALID_REQUEST`, without a Set-Cookie or authorization URL.
 */
export class FederatedLinkCookieHeaderTooLargeError extends Error {
  constructor() {
    super('federated-auth-state: link flow cookie admission failed — the projected Cookie header exceeds the byte budget even after pruning');
    this.name = 'FederatedLinkCookieHeaderTooLargeError';
  }
}

/** `{ publicJwk, signature }` — see `verifySenderProof`'s doc comment for the canonical-message contract. */
export interface SenderProof {
  publicJwk: webcrypto.JsonWebKey;
  /** base64url ES256 signature. */
  signature: string;
}

export interface FederatedAuthCookieOptions {
  httpOnly: true;
  sameSite: 'Lax';
  secure: boolean;
  path: string;
  /** Seconds, matching `hono/cookie`'s `CookieOptions.maxAge`. */
  maxAge: number;
}

export interface FederatedAuthStateUtil {
  readonly cookieName: string;
  readonly cookieOptions: FederatedAuthCookieOptions;
  /** cookie options for a link-flow cookie (same shape, distinct `Path`/name-per-state — see `linkCookieNameFor`). */
  readonly linkCookieOptions: FederatedAuthCookieOptions;
  /** Serialize a fresh state (stamping `expiresAt` = now + 300s) into the opaque cookie VALUE. */
  issue(payload: Omit<FederatedAuthState, 'expiresAt'>): string;
  /**
   * Verify + parse a cookie value, additionally checking `state.provider ===
   * expectedProvider` (the callback's `:name` route param) — a state cookie
   * minted for one provider must never validate a different provider's
   * callback. Returns `null` for a missing cookie, a tampered/mismatched
   * signature, a malformed payload, an expired `expiresAt`, a provider
   * mismatch, OR a payload carrying the reserved link fields
   * (`flow`) — callers cannot distinguish these cases (and must not try to:
   * RFC-0014 phase 1 treats them all as the same "invalid_state" login
   * error).
   */
  verify(cookieValue: string | undefined, expectedProvider: string): FederatedAuthState | null;
  /**
   * serialize a
   * fresh `FederatedLinkState` (stamping `expiresAt` = `now` + 300s) into the
   * opaque link cookie VALUE. `now` is caller-supplied (Redis `TIME` for a
   * multi-instance topology, the same process `Date.now()` for Map/single-
   * instance) — see the module doc comment on why this store never reads
   * `Date.now()` itself. Throws {@link FederatedLinkStateCookieTooLargeError}
   * when the serialized value exceeds {@link MAX_LINK_STATE_COOKIE_VALUE_BYTES}.
   */
  issueLink(payload: Omit<FederatedLinkState, 'expiresAt'>, now: number): string;
  /**
   * Verify + parse a link cookie value against the query-derived
   * `expected.state`/`expected.provider`, using caller-supplied `now` for
   * the expiry check (see `issueLink`'s doc comment). Returns `null` for a
   * missing cookie, a tampered/mismatched signature, a malformed payload, a
   * non-`'link'` `flow`, an expired `expiresAt`, or a state/provider
   * mismatch — the callback treats all of these as one generic link
   * failure, same posture as `verify()`.
   */
  verifyLink(cookieValue: string | undefined, expected: { state: string; provider: string }, now: number): FederatedLinkState | null;
  /**
   * decide which
   * (if any) existing link-flow cookies a `link-start` response must expire
   * before/alongside setting `freshCookieName=freshCookieValue`, from the
   * request's raw `Cookie` header. Scans EVERY `;`-separated raw token:
   * ordinary (non-link) cookies are never touched; invalid or signed-expired
   * link cookies are unconditional prune candidates; count- and byte-budget
   * overflow prune the OLDEST remaining valid link cookies next. Throws
   * {@link FederatedLinkCookieHeaderTooLargeError} when even a fully-pruned
   * projection cannot fit — see that error's doc comment.
   */
  planLinkCookiePrune(cookieHeader: string | undefined, freshCookieName: string, freshCookieValue: string, now: number): LinkCookiePrunePlan;
}

/**
 * HKDF-SHA-256 with an explicit empty-buffer salt. RFC 5869 §2.2 defines
 * "no salt provided" as `HashLen` (32) zero bytes; HMAC itself zero-pads
 * any key shorter than its block size (64 bytes for SHA-256) up to the
 * block size before use, so a 0-byte salt and a 32-zero-byte salt both
 * end up as the same 64-zero-byte HMAC key in the `extract` step — the
 * two are cryptographically equivalent here, and `Buffer.alloc(0)` is
 * what Node's `crypto.hkdfSync` accepts without a redundant explicit
 * zero-fill.
 */
function deriveStateHmacKey(secret: string): Buffer {
  const okm = crypto.hkdfSync('sha256', secret, Buffer.alloc(0), STATE_HKDF_INFO, 32);
  return Buffer.from(okm);
}

/** Constant-time string comparison — also reused by `hono/handlers/federated-auth.ts` for its own state/JKT comparisons. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build the state-cookie HMAC key from the SAME secret source
 * `util/jwt.ts#createJwtUtil` reads (kept as a literal duplicate — not a
 * shared import — so this module never has to import from `crowi/index`'s
 * `Crowi` class, and so a future change to `createJwtUtil`'s fallback chain
 * is a deliberate, reviewable two-file diff rather than an invisible
 * cross-module coupling).
 */
function resolveAppSecret(crowi: Pick<Crowi, 'getConfig'>): string {
  const config = crowi.getConfig();
  return (config.crowi['app:secret'] as string | undefined) || (config.crowi['SECRET_TOKEN'] as string | undefined) || 'your-secret-key';
}

/** Verify an HMAC-signed `<payloadB64>.<mac>` cookie value against `key`; returns the decoded JSON payload (unvalidated shape) or `null` for any signature/decode failure. Shared by sign-in `verify`, `verifyLink`, and `planLinkCookiePrune`'s per-token scan. */
function verifySignedCookieValue(key: Buffer, cookieValue: string): unknown {
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expectedMac = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
  if (!timingSafeEqualStrings(mac, expectedMac)) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function signCookieValue(key: Buffer, payload: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
  return `${payloadB64}.${mac}`;
}

/** Raw `;`-separated `Cookie` header tokens, trimmed, blanks dropped. Preserves each token's original `name=value` text verbatim (re-joined later with `'; '` regardless of the incoming separator — see `planLinkCookiePrune`'s doc comment on the spec's design decision 7). */
function parseRawCookieTokens(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(';')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function createFederatedAuthStateUtil(crowi: Pick<Crowi, 'getConfig' | 'node_env'>): FederatedAuthStateUtil {
  const key = deriveStateHmacKey(resolveAppSecret(crowi));

  const decodeLinkCookieForPrune = (value: string): { expiresAt: number } | null => {
    const parsed = verifySignedCookieValue(key, value);
    if (!isFederatedLinkStateShape(parsed)) return null;
    return { expiresAt: parsed.expiresAt };
  };

  return {
    cookieName: STATE_COOKIE_NAME,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'Lax',
      secure: crowi.node_env === 'production',
      path: STATE_COOKIE_PATH,
      maxAge: STATE_TTL_MS / 1000,
    },
    linkCookieOptions: {
      httpOnly: true,
      sameSite: 'Lax',
      secure: crowi.node_env === 'production',
      path: LINK_STATE_COOKIE_PATH,
      maxAge: STATE_TTL_MS / 1000,
    },
    issue(payload) {
      const full: FederatedAuthState = { ...payload, expiresAt: Date.now() + STATE_TTL_MS };
      const cookieValue = signCookieValue(key, full);
      const byteLength = Buffer.byteLength(cookieValue, 'utf8');
      if (byteLength > MAX_STATE_COOKIE_VALUE_BYTES) {
        throw new Error(
          `federated-auth-state: issued state cookie value is ${byteLength} bytes, exceeding the ${MAX_STATE_COOKIE_VALUE_BYTES}-byte invariant — reject the oversized input (e.g. continue) before calling issue()`,
        );
      }
      return cookieValue;
    },
    verify(cookieValue, expectedProvider) {
      if (!cookieValue) return null;
      const parsed = verifySignedCookieValue(key, cookieValue);
      if (!isFederatedAuthStateShape(parsed)) return null;
      if (parsed.expiresAt < Date.now()) return null;
      if (parsed.provider !== expectedProvider) return null;
      return parsed;
    },
    issueLink(payload, now) {
      const full: FederatedLinkState = { ...payload, expiresAt: now + STATE_TTL_MS };
      const cookieValue = signCookieValue(key, full);
      if (Buffer.byteLength(cookieValue, 'utf8') > MAX_LINK_STATE_COOKIE_VALUE_BYTES) {
        throw new FederatedLinkStateCookieTooLargeError();
      }
      return cookieValue;
    },
    verifyLink(cookieValue, expected, now) {
      if (!cookieValue) return null;
      const parsed = verifySignedCookieValue(key, cookieValue);
      if (!isFederatedLinkStateShape(parsed)) return null;
      if (parsed.expiresAt <= now) return null;
      if (parsed.provider !== expected.provider) return null;
      if (parsed.state !== expected.state) return null;
      return parsed;
    },
    planLinkCookiePrune(cookieHeader, freshCookieName, freshCookieValue, now) {
      const tokens = parseRawCookieTokens(cookieHeader);
      const ordinaryTokens: string[] = [];
      // Oldest-expiry-first once sorted — pruned first when count/budget still overflow after invalid+expired are already gone.
      const liveLinkCookies: { token: string; name: string; expiresAt: number }[] = [];
      const expireCookieNamesSet = new Set<string>();

      for (const token of tokens) {
        const eq = token.indexOf('=');
        const name = eq === -1 ? token : token.slice(0, eq);
        const value = eq === -1 ? '' : token.slice(eq + 1);
        if (!name.startsWith(LINK_STATE_COOKIE_PREFIX)) {
          ordinaryTokens.push(token);
          continue;
        }
        const decoded = decodeLinkCookieForPrune(value);
        if (!decoded || decoded.expiresAt <= now) {
          // Invalid, or a signed-but-expired link cookie — unconditional prune candidate.
          expireCookieNamesSet.add(name);
          continue;
        }
        liveLinkCookies.push({ token, name, expiresAt: decoded.expiresAt });
      }
      liveLinkCookies.sort((a, b) => a.expiresAt - b.expiresAt);

      // Count admission: projected live count (retained + 1 fresh) <= MAX_LINK_FLOW_COOKIE_COUNT.
      while (liveLinkCookies.length + 1 > MAX_LINK_FLOW_COOKIE_COUNT) {
        const oldest = liveLinkCookies.shift();
        if (!oldest) break;
        expireCookieNamesSet.add(oldest.name);
      }

      const freshPair = `${freshCookieName}=${freshCookieValue}`;
      const computeProjectedBytes = (): number => {
        const retained = [...ordinaryTokens, ...liveLinkCookies.map((c) => c.token)];
        const joined = retained.length > 0 ? `${retained.join('; ')}; ${freshPair}` : freshPair;
        return Buffer.byteLength(joined, 'utf8');
      };

      let projectedCookieHeaderBytes = computeProjectedBytes();
      // Byte-budget admission: prune the oldest remaining live link cookies until the projected header fits, or none are left to prune.
      while (projectedCookieHeaderBytes > MAX_LINK_COOKIE_HEADER_BYTES && liveLinkCookies.length > 0) {
        const oldest = liveLinkCookies.shift();
        if (!oldest) break;
        expireCookieNamesSet.add(oldest.name);
        projectedCookieHeaderBytes = computeProjectedBytes();
      }

      const fitsHeaderBudget = projectedCookieHeaderBytes <= MAX_LINK_COOKIE_HEADER_BYTES;
      const fitsNodeHeaderCeiling = projectedCookieHeaderBytes + LINK_COOKIE_HEADER_RACE_RESERVE_BYTES < NODE_DEFAULT_MAX_HEADER_SIZE_BYTES;
      if (!fitsHeaderBudget || !fitsNodeHeaderCeiling) {
        throw new FederatedLinkCookieHeaderTooLargeError();
      }

      return { expireCookieNames: [...expireCookieNamesSet], projectedCookieHeaderBytes };
    },
  };
}

function isFederatedAuthStateShape(value: unknown): value is FederatedAuthState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.provider === 'string' &&
    typeof v.expiresAt === 'number' &&
    typeof v.continuePath === 'string' &&
    typeof v.handoffJkt === 'string' &&
    (v.codeVerifier === undefined || typeof v.codeVerifier === 'string') &&
    (v.oidcNonce === undefined || typeof v.oidcNonce === 'string') &&
    // a sign-in
    // state must never carry the deprecated link fields or the link `flow`
    // marker. Rejecting them here (rather than merely ignoring extras) is
    // what makes a link-shaped payload provably unable to validate as a
    // sign-in state, and vice versa.
    v.linkToUserId === undefined &&
    v.linkAuthVersion === undefined &&
    v.flow === undefined
  );
}

function isFederatedLinkStateShape(value: unknown): value is FederatedLinkState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.flow === 'link' &&
    typeof v.state === 'string' &&
    typeof v.provider === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.authVersion === 'number' &&
    typeof v.expiresAt === 'number' &&
    (v.codeVerifier === undefined || typeof v.codeVerifier === 'string') &&
    (v.oidcNonce === undefined || typeof v.oidcNonce === 'string')
  );
}

/**
 * Ordinary sign-in
 * `state` generator, unchanged in shape (32 random bytes -> 43-char
 * base64url — same wire length/alphabet as before) but now rejection-samples
 * around the reserved link namespace so a sign-in state can never
 * collide with `LINK_STATE_VALUE_PATTERN` by chance.
 */
export function generateSignInStateValue(): string {
  let value: string;
  do {
    value = crypto.randomBytes(32).toString('base64url');
  } while (value.startsWith(LINK_STATE_VALUE_PREFIX));
  return value;
}

/** link `state` generator: `crowilnk_` + 25 random bytes (34-char base64url) = 43 chars total. */
export function generateLinkStateValue(): string {
  return `${LINK_STATE_VALUE_PREFIX}${crypto.randomBytes(LINK_STATE_RANDOM_BYTES).toString('base64url')}`;
}

/** The link-flow cookie NAME for a given `state`, or `null` when `state` does not match {@link LINK_STATE_VALUE_PATTERN} — callers must never build a cookie name from an unvalidated value. */
export function linkCookieNameFor(state: string): string | null {
  if (!LINK_STATE_VALUE_PATTERN.test(state)) return null;
  return `${LINK_STATE_COOKIE_PREFIX}${state}`;
}

/**
 * RFC 7638 JSON Web Key Thumbprint for a P-256 EC public key: SHA-256 over
 * the canonical JSON `{"crv":...,"kty":"EC","x":...,"y":...}` (lexicographic
 * key order, no whitespace — RFC 7638 §3.2), base64url-encoded. The caller
 * is responsible for having already validated `jwk.kty === 'EC'` /
 * `jwk.crv === 'P-256'` — this function does not re-validate the shape.
 */
export function computeJwkThumbprint(jwk: webcrypto.JsonWebKey): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * ES256-verify `proof.signature` (base64url, JOSE raw r‖s format — the
 * format Web Crypto's ECDSA sign/verify natively produces/expects, no DER)
 * against `message` (UTF-8) using `proof.publicJwk`. Returns `false`
 * (never throws) for any malformed input, non-EC/non-P-256 JWK, or
 * signature mismatch — see the module doc comment for why this key never
 * doubles as a bearer capability by itself.
 */
export async function verifySenderProof(proof: SenderProof, message: string): Promise<boolean> {
  const jwk = proof.publicJwk;
  if (jwk == null || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    return false;
  }
  try {
    const publicKey = await crypto.webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signature = Buffer.from(proof.signature, 'base64url');
    const data = new TextEncoder().encode(message);
    return await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data);
  } catch {
    return false;
  }
}

/**
 * Canonical message the sender signs at `/start` (design decision 3):
 * `GET\n<apiUrl>/api/auth/providers/<providerName>/start\n<continuePath>\n<publicJwkB64>`.
 * `apiUrl` MUST be the trusted, already-resolved `AUTH_PUBLIC_API_URL`
 * origin (never a request Host) and `publicJwkB64` MUST be the exact
 * `handoff_jwk` query-string value (base64url JSON, already canonical —
 * never re-encoded).
 */
export function buildStartCanonicalMessage(apiUrl: string, providerName: string, continuePath: string, publicJwkB64: string): string {
  return `GET\n${buildProviderStartUrl(apiUrl, providerName)}\n${continuePath}\n${publicJwkB64}`;
}

/**
 * Canonical message the sender signs at `/handoff` (design decision 4):
 * `POST\n<apiUrl>/api/auth/handoff\n<code>`.
 */
export function buildHandoffCanonicalMessage(apiUrl: string, code: string): string {
  return `POST\n${buildHandoffUrl(apiUrl)}\n${code}`;
}

/** Trusted-origin URL builders — every federated-auth URL is assembled from ONLY `AUTH_PUBLIC_API_URL` / `AUTH_PUBLIC_WEB_URL`, never a request Host/Origin/forwarded header. */
export function buildProviderStartUrl(apiUrl: string, providerName: string): string {
  return `${apiUrl}/api/auth/providers/${encodeURIComponent(providerName)}/start`;
}

export function buildProviderCallbackUrl(apiUrl: string, providerName: string): string {
  return `${apiUrl}/api/auth/providers/${encodeURIComponent(providerName)}/callback`;
}

export function buildHandoffUrl(apiUrl: string): string {
  return `${apiUrl}/api/auth/handoff`;
}

/**
 * RFC-0014 §5.3: `/login/complete?code=<code>&continue=<validated path>` —
 * `continuePath` MUST be re-echoed here (it is the whole reason `/start`
 * validates and signs it into the state cookie in the first place: the web
 * app has no other trusted channel to recover the caller's original
 * destination once the browser has round-tripped through the IdP and back).
 * `continuePath` is always already a validated local path by the time it
 * reaches here — verified at `/start` (`ContinuePathSchema`, api-contract)
 * and carried unchanged through the signed, tamper-evident state cookie —
 * so no re-validation happens at this call site.
 */
export function buildLoginCompleteUrl(webUrl: string, handoffCode: string, continuePath: string): string {
  const url = new URL('/login/complete', webUrl);
  url.searchParams.set('code', handoffCode);
  url.searchParams.set('continue', continuePath);
  return url.toString();
}

export function buildLoginErrorUrl(webUrl: string, errorCode: string): string {
  const url = new URL('/login', webUrl);
  url.searchParams.set('error', errorCode);
  return url.toString();
}

/**
 * Where a
 * successful link callback lands: `/me?provider=<provider>&link_completion=<code>`.
 * Never `/login`: the visitor was already signed in the whole time, so
 * bouncing them through the login screen would read as "you got signed
 * out" for what is really a settings change. Carries ONLY `provider` +
 * the completion `code` — never `accountLabel`, never a result string (the
 * confirmation GET/POST decide and report the actual outcome).
 */
export function buildLinkCompletionUrl(webUrl: string, provider: string, code: string): string {
  const url = new URL('/me', webUrl);
  url.searchParams.set('provider', provider);
  url.searchParams.set('link_completion', code);
  return url.toString();
}

/**
 * Where a FAILED
 * link callback lands: `/me?provider=<provider>&link=link_failed`. Carries
 * ONLY `provider` + the single generic failure marker — never a completion
 * code, never `accountLabel`, never the underlying reason (protocol
 * failure, duplicate-issue race, oversized cookie, ...) — the callback
 * link branch never reveals WHY to the browser.
 */
export function buildLinkFailureUrl(webUrl: string, provider: string): string {
  const url = new URL('/me', webUrl);
  url.searchParams.set('provider', provider);
  url.searchParams.set('link', 'link_failed');
  return url.toString();
}

/**
 * RFC-0014 phase 2 — the trusted web federated-registration screen. `token`
 * is a one-time secret (a `PendingAuthRegistration` grant); the page reads
 * it only client-side (`hono/handlers/federated-registration.ts`'s own
 * doc comment / the phase 2 spec's implementation map — never rendered
 * server-side).
 */
export function buildRegistrationRedirectUrl(webUrl: string, token: string): string {
  const url = new URL('/register/federated', webUrl);
  url.searchParams.set('token', token);
  return url.toString();
}
