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
import crypto from 'node:crypto';
import type { webcrypto } from 'node:crypto';

import type Crowi from 'src/crowi';

/** `Max-Age` for the state cookie — 300 seconds (RFC-0014 phase 1 §"契約・不変条件"). */
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
  /**
   * RFC-0014 phase 3 — set ONLY by a `link=1` start, from the authenticated
   * session's own user id (never from a query parameter, never from the
   * IdP profile). Its presence is what switches the callback from "sign
   * someone in" to "attach this identity to that account", and because it
   * lives inside the HMAC-signed cookie, the callback cannot be steered at
   * a different account by anything the browser or the IdP sends back.
   */
  linkToUserId?: string;
  /**
   * `User.authVersion` captured when the link grant was minted. Re-read and
   * compared at callback time so a session invalidated mid-flow (password
   * reset, forced sign-out) links nothing — the signed state alone would
   * otherwise stay valid for its full 5 minutes.
   */
  linkAuthVersion?: number;
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
  /** Serialize a fresh state (stamping `expiresAt` = now + 300s) into the opaque cookie VALUE. */
  issue(payload: Omit<FederatedAuthState, 'expiresAt'>): string;
  /**
   * Verify + parse a cookie value, additionally checking `state.provider ===
   * expectedProvider` (the callback's `:name` route param) — a state cookie
   * minted for one provider must never validate a different provider's
   * callback. Returns `null` for a missing cookie, a tampered/mismatched
   * signature, a malformed payload, an expired `expiresAt`, or a provider
   * mismatch — callers cannot distinguish these cases (and must not try to:
   * RFC-0014 phase 1 treats them all as the same "invalid_state" login
   * error).
   */
  verify(cookieValue: string | undefined, expectedProvider: string): FederatedAuthState | null;
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

export function createFederatedAuthStateUtil(crowi: Pick<Crowi, 'getConfig' | 'node_env'>): FederatedAuthStateUtil {
  const key = deriveStateHmacKey(resolveAppSecret(crowi));

  return {
    cookieName: STATE_COOKIE_NAME,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'Lax',
      secure: crowi.node_env === 'production',
      path: STATE_COOKIE_PATH,
      maxAge: STATE_TTL_MS / 1000,
    },
    issue(payload) {
      const full: FederatedAuthState = { ...payload, expiresAt: Date.now() + STATE_TTL_MS };
      const payloadB64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
      const mac = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
      const cookieValue = `${payloadB64}.${mac}`;
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
      const dot = cookieValue.lastIndexOf('.');
      if (dot < 1) return null;
      const payloadB64 = cookieValue.slice(0, dot);
      const mac = cookieValue.slice(dot + 1);
      const expectedMac = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
      if (!timingSafeEqualStrings(mac, expectedMac)) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!isFederatedAuthStateShape(parsed)) return null;
      if (parsed.expiresAt < Date.now()) return null;
      if (parsed.provider !== expectedProvider) return null;
      return parsed;
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
    (v.linkToUserId === undefined || typeof v.linkToUserId === 'string') &&
    (v.linkAuthVersion === undefined || typeof v.linkAuthVersion === 'number')
  );
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
 * RFC-0014 phase 3 — where a LINK callback lands. Never `/login`: the
 * visitor was already signed in the whole time, so bouncing them through
 * the login screen would read as "you got signed out" for what is really a
 * settings change. `result` is a stable, non-identifying code the settings
 * page turns into copy (phase 4 owns the wording); notably
 * `federated_identity_in_use` never says WHICH account holds the identity.
 */
export function buildLinkSettingsUrl(webUrl: string, provider: string, result: 'linked' | 'federated_identity_in_use' | 'link_failed'): string {
  const url = new URL('/me', webUrl);
  url.searchParams.set('provider', provider);
  url.searchParams.set('link', result);
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
