import { createHash } from 'node:crypto';
import type { Configuration } from 'openid-client';

/**
 * Auth provider profile, normalised across providers (Google / GitHub /
 * future SAML / OIDC). Plugins map the upstream token / profile into
 * this shape; core looks up or provisions a User by `providerUserId`.
 */
export interface AuthProfile {
  /**
   * Stable identifier for this user *within the provider's namespace*.
   * Google: the `sub` claim. GitHub: the numeric account id as string.
   * Plugins must NEVER use email / username for this — those rotate.
   */
  providerUserId: string;
  /** Email address from the provider. May be empty if not granted. */
  email?: string;
  /** Display name from the provider. */
  name?: string;
  /** Avatar URL from the provider. */
  imageUrl?: string;
  /**
   * Free-form additional fields the plugin wants to persist on the
   * user document (e.g. github org membership). Stored under the
   * plugin's pageMetadata-style namespace on User.
   */
  extra?: Record<string, unknown>;
}

/**
 * Result of `verify` / `fetchProfile` — either a normalised profile
 * (success) or an error reason the login UI surfaces.
 */
export type AuthVerifyResult = { ok: true; profile: AuthProfile } | { ok: false; reason: string };

/** One field to render on a `credential` driver's sign-in form. */
export interface CredentialField {
  /** Form field name, e.g. `'username'` / `'password'`. */
  name: string;
  /** Human-readable label rendered next to the field. */
  label: string;
  /** Input type. Defaults to `'text'` when omitted. */
  type?: 'text' | 'email' | 'password';
  required?: boolean;
}

/**
 * Direct-credential auth: the user submits credentials to Crowi itself
 * (LDAP, local password). No redirect, no external IdP round-trip.
 */
export interface CredentialAuthDriver {
  kind: 'credential';
  /** Usually omitted — credential drivers render as the sign-in form. */
  buttonLabel?: string;
  /** Fields to render on the sign-in form (e.g. [username, password]). */
  fields: CredentialField[];
  verify(credentials: Record<string, string>): Promise<AuthVerifyResult>;
}

/**
 * OAuth 2.0 / OIDC client credentials, read lazily at request time (see
 * `getClientConfig()` below) rather than captured at registration.
 */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/** Token response from an OAuth 2.0 / OIDC token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
  /** Present for an OIDC token response — the raw, still-unverified id_token JWT. */
  idToken?: string;
}

/**
 * Redirect/federated auth: the browser bounces to an external IdP using
 * the plain OAuth 2.0 authorization-code flow (no id_token).
 */
export interface OAuth2AuthDriver {
  kind: 'oauth2';
  buttonLabel: string;
  iconUrl?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Declare when the IdP supports PKCE (S256). */
  pkce?: boolean;
  /**
   * Lazy accessor, evaluated per request — NOT captured at registration.
   * Returns null while the plugin is unconfigured; core then hides the
   * provider from the provider list (enablement) and rejects `/start`.
   * Lazy evaluation is also what makes admin config changes take effect
   * without re-registering the driver.
   */
  getClientConfig(): OAuthClientConfig | null;
  /**
   * Exchange completed; fetch the provider profile and map it. Returns
   * `AuthVerifyResult` so the driver can REJECT after a successful
   * exchange (e.g. an org-membership gate) — a successful exchange does
   * not by itself guarantee a successful sign-in.
   */
  fetchProfile(tokens: OAuthTokens): Promise<AuthVerifyResult>;
}

/** OIDC = OAuth 2.0 + standardised discovery + id_token claims. */
export interface OidcAuthDriver {
  kind: 'oidc';
  buttonLabel: string;
  iconUrl?: string;
  /** `…/.well-known/openid-configuration` */
  discoveryUrl: string;
  /** Default `['openid', 'email', 'profile']`. */
  scopes: string[];
  /** OIDC always uses PKCE. */
  pkce: true;
  /** Same lazy contract as `OAuth2AuthDriver.getClientConfig()`. */
  getClientConfig(): OAuthClientConfig | null;
  /**
   * Resolve (and cache) the `openid-client` `Configuration` for this
   * driver's current credentials. Returns `null` without performing any
   * network I/O while `getClientConfig()` is unconfigured. See the
   * discovery-cache doc comment below for the caching contract.
   */
  getConfiguration(): Promise<Configuration | null>;
  /**
   * Optional policy gate, called after core validates the id_token and
   * before `mapClaims` — the OIDC analogue of `fetchProfile`'s
   * rejection (e.g. a Google Workspace `hd` domain restriction).
   */
  authorize?(claims: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Optional claim → AuthProfile override; default maps sub/email/name. */
  mapClaims?(claims: Record<string, unknown>): Partial<AuthProfile>;
}

/**
 * `'saml'` is reserved (RFC-0014 §9) for a future `SamlAuthDriver` — it is
 * a valid `AuthDriverKind` so downstream code can already discriminate on
 * it, but no `SamlAuthDriver` interface exists yet and `AuthDriver` below
 * does not include it as a member. SAML's required attributes and
 * callback shape are still undecided; adding a member type ahead of that
 * design would let a plugin construct a value with no real runtime.
 */
export type AuthDriverKind = 'credential' | 'oauth2' | 'oidc' | 'saml';

/**
 * Auth provider driver. The login screen asks core for the list of
 * registered drivers and renders one button per `oauth2`/`oidc` driver
 * (`Sign in with Google`) or one sign-in form per `credential` driver.
 * See RFC-0014 §3 for the full design rationale.
 */
export type AuthDriver = CredentialAuthDriver | OAuth2AuthDriver | OidcAuthDriver;

export interface AuthRegistry {
  register(driverName: string, driver: AuthDriver): void;
}

// ---------------------------------------------------------------------------
// Factories — reusable protocol logic shipped by the SDK (RFC-0014 §4).
//
// Both factories are PURE at call time: they validate their static inputs
// synchronously and close over `getClientConfig` / other option functions
// without ever calling them. No network I/O, no config read, happens until
// a caller later invokes `getConfiguration()` (oidc) or the core flow
// skeleton invokes `getClientConfig()` / `fetchProfile()` (Phase 1+).
// ---------------------------------------------------------------------------

function assertNonEmptyString(value: string, label: string, factory: string): void {
  if (value.trim() === '') {
    throw new TypeError(`${factory}: '${label}' must be a non-empty string.`);
  }
}

function assertValidUrl(value: string, label: string, factory: string): void {
  try {
    new URL(value);
  } catch {
    throw new TypeError(`${factory}: '${label}' must be a valid URL, got '${value}'.`);
  }
}

function assertNonEmptyScopes(scopes: string[], factory: string): void {
  for (const scope of scopes) {
    assertNonEmptyString(scope, 'scopes[]', factory);
  }
}

export interface CreateOAuth2DriverOptions {
  buttonLabel: string;
  iconUrl?: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Defaults to `[]` when omitted. */
  scopes?: string[];
  pkce?: boolean;
  getClientConfig(): OAuthClientConfig | null;
  fetchProfile(tokens: OAuthTokens): Promise<AuthVerifyResult>;
}

/**
 * Build a plain OAuth 2.0 authorization-code driver. Synchronous, I/O-free
 * — see the module doc comment above.
 */
export function createOAuth2Driver(options: CreateOAuth2DriverOptions): OAuth2AuthDriver {
  const FACTORY = 'createOAuth2Driver';
  assertNonEmptyString(options.buttonLabel, 'buttonLabel', FACTORY);
  assertValidUrl(options.authorizeUrl, 'authorizeUrl', FACTORY);
  assertValidUrl(options.tokenUrl, 'tokenUrl', FACTORY);
  const scopes = options.scopes ?? [];
  assertNonEmptyScopes(scopes, FACTORY);

  return {
    kind: 'oauth2',
    buttonLabel: options.buttonLabel,
    iconUrl: options.iconUrl,
    authorizeUrl: options.authorizeUrl,
    tokenUrl: options.tokenUrl,
    scopes,
    pkce: options.pkce,
    getClientConfig: options.getClientConfig,
    fetchProfile: options.fetchProfile,
  };
}

const DEFAULT_OIDC_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

export interface CreateOidcDriverOptions {
  buttonLabel: string;
  iconUrl?: string;
  discoveryUrl: string;
  /** Defaults to `['openid', 'email', 'profile']` when omitted. */
  scopes?: string[];
  getClientConfig(): OAuthClientConfig | null;
  authorize?(claims: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }>;
  mapClaims?(claims: Record<string, unknown>): Partial<AuthProfile>;
}

/**
 * Build an OIDC driver. Synchronous, I/O-free at call time — see the
 * module doc comment above. `getConfiguration()` on the returned driver
 * is the only entry point that performs discovery, and only on first use
 * (see `resolveOidcConfiguration` below).
 */
export function createOidcDriver(options: CreateOidcDriverOptions): OidcAuthDriver {
  const FACTORY = 'createOidcDriver';
  assertNonEmptyString(options.buttonLabel, 'buttonLabel', FACTORY);
  assertValidUrl(options.discoveryUrl, 'discoveryUrl', FACTORY);
  const scopes = options.scopes ?? [...DEFAULT_OIDC_SCOPES];
  assertNonEmptyScopes(scopes, FACTORY);

  return {
    kind: 'oidc',
    buttonLabel: options.buttonLabel,
    iconUrl: options.iconUrl,
    discoveryUrl: options.discoveryUrl,
    scopes,
    pkce: true,
    getClientConfig: options.getClientConfig,
    getConfiguration: () => resolveOidcConfiguration(options.discoveryUrl, options.getClientConfig),
    authorize: options.authorize,
    mapClaims: options.mapClaims,
  };
}

// ---------------------------------------------------------------------------
// OIDC discovery cache
//
// `Configuration` (from `openid-client`) holds the client secret, so the
// cache key is a fingerprint — never the raw secret — derived from
// `SHA-256(discoveryUrl + NUL + clientId + NUL + SHA-256(clientSecret))`.
// TTL is 5 minutes; concurrent callers for the same key share one in-flight
// discovery Promise (only a successful discovery is cached — a failed
// Promise is removed so the next caller retries). Rotating the client
// secret changes the fingerprint, so the very next call misses the cache
// and starts a fresh discovery under the new key; the old entry is simply
// unreachable and expires normally.
//
// This cache is shared module-wide across every OIDC driver instance
// (rather than per-driver) and bounded to `DISCOVERY_CACHE_MAX_ENTRIES` —
// the number of OIDC providers registered depends on the plugin registry,
// so an unbounded map is avoided; the entry with the earliest expiry is
// evicted to make room.
// ---------------------------------------------------------------------------

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_CACHE_MAX_ENTRIES = 64;

interface DiscoveryCacheEntry {
  configuration: Configuration;
  expiresAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const inFlightDiscoveries = new Map<string, Promise<Configuration>>();

function discoveryCacheKey(discoveryUrl: string, clientId: string, clientSecret: string): string {
  const secretFingerprint = createHash('sha256').update(clientSecret).digest('hex');
  return createHash('sha256').update(`${discoveryUrl}\0${clientId}\0${secretFingerprint}`).digest('hex');
}

function evictOldestDiscoveryCacheEntry(): void {
  let oldestKey: string | undefined;
  let oldestExpiresAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of discoveryCache) {
    if (entry.expiresAt < oldestExpiresAt) {
      oldestExpiresAt = entry.expiresAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    discoveryCache.delete(oldestKey);
  }
}

function cacheDiscoveryResult(key: string, configuration: Configuration): void {
  if (!discoveryCache.has(key) && discoveryCache.size >= DISCOVERY_CACHE_MAX_ENTRIES) {
    evictOldestDiscoveryCacheEntry();
  }
  discoveryCache.set(key, { configuration, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
}

/**
 * `getConfiguration()`'s implementation. `import('openid-client')` is
 * deferred to inside this function (rather than a static top-level
 * import) so the package — published ESM-only — is never loaded until a
 * driver's discovery actually runs; registration and any consumer that
 * merely imports driver *types* never touch it.
 */
async function resolveOidcConfiguration(discoveryUrl: string, getClientConfig: () => OAuthClientConfig | null): Promise<Configuration | null> {
  const clientConfig = getClientConfig();
  if (clientConfig == null) return null;

  // Snapshot into primitive locals immediately, and use only these locals
  // (never `clientConfig` itself) for both the cache key and the eventual
  // `discovery()` call below. `OAuthClientConfig` is a plugin-authored
  // object — nothing guarantees `getClientConfig()` returns a fresh object
  // per call, so a plugin that mutates a shared config object in place
  // (e.g. on admin save) could otherwise change `clientConfig.clientSecret`
  // during the `await import('openid-client')` below, between when the key
  // is computed and when discovery actually reads the secret. Reading the
  // secret twice from a mutable object across that await would let a new
  // secret's `Configuration` be cached under the *old* secret's fingerprint
  // key. Strings are immutable primitives, so snapshotting closes that gap.
  const { clientId, clientSecret } = clientConfig;

  const key = discoveryCacheKey(discoveryUrl, clientId, clientSecret);

  const cached = discoveryCache.get(key);
  if (cached !== undefined) {
    if (cached.expiresAt > Date.now()) return cached.configuration;
    discoveryCache.delete(key);
  }

  const inFlight = inFlightDiscoveries.get(key);
  if (inFlight !== undefined) return inFlight;

  const discoveryPromise = (async () => {
    const { discovery } = await import('openid-client');
    const configuration = await discovery(new URL(discoveryUrl), clientId, clientSecret);
    cacheDiscoveryResult(key, configuration);
    return configuration;
  })();

  inFlightDiscoveries.set(key, discoveryPromise);
  try {
    return await discoveryPromise;
  } finally {
    inFlightDiscoveries.delete(key);
  }
}
