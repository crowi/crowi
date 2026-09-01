/**
 * RFC-0014 phase 1 — federated (OAuth2/OIDC) sign-in flow skeleton, plus the
 * account-link flow as 3 authenticated stages instead of a single
 * `jwtAuth`-gated top-level GET (a top-level browser navigation cannot carry
 * an `Authorization` header, so that never worked once linking required
 * authentication — see RFC-0014 §5.4):
 *
 *   GET  /auth/providers                — public, enabled provider list
 *   GET  /auth/providers/{name}/start   — public, top-level-navigation redirect to the IdP (sign-in ONLY)
 *   GET  /auth/providers/{name}/callback — public, IdP redirect target (branches on the query `state` namespace)
 *   POST /auth/handoff                  — public, sender-constrained code -> session tokens
 *   POST /auth/providers/{name}/link-start                — web-session-only, mints the IdP authorization URL + flow cookie
 *   GET  /auth/providers/{name}/link-completions/{code}   — web-session-only, non-destructive confirmation read
 *   POST /auth/providers/{name}/link-completions/{code}   — web-session-only, atomic consume + identity insert
 *
 * Phase 1 wires the OAuth2/OIDC PROTOCOL only — provisioning is
 * `FederatedProfileTerminal`'s job, and Phase 1's own terminal
 * (`createUnavailableFederatedProfileTerminal`) never reads or writes
 * `User`/`UserIdentity`. The link branch bypasses `FederatedProfileTerminal`
 * entirely (a link targets an account that already exists and is already
 * signed in) and never touches the DB at callback time — see
 * `completeLinkCallback`'s doc comment.
 */

import type { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';
import {
  callbackFederatedProviderRoute,
  completeProviderLinkRoute,
  federatedHandoffRoute,
  getProviderLinkCompletionRoute,
  listFederatedProvidersRoute,
  listLinkedAuthProvidersRoute,
  startFederatedProviderRoute,
  startProviderLinkRoute,
  unlinkAuthProviderRoute,
} from '@crowi/api-contract';
import type { AuthDriver, AuthProfile, AuthVerifyResult, OAuth2AuthDriver, OAuthClientConfig, OAuthTokens, OidcAuthDriver } from '@crowi/plugin-api';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  type AuthProviderLinkingTerminal,
  createAuthProviderLinkingTerminal,
  resolveAuthProviderLinkReplay,
  unlinkFederatedIdentity,
} from 'src/auth/auth-provider-linking';
import { createUnavailableFederatedProfileTerminal, type FederatedProfileTerminal } from 'src/auth/federated-profile-terminal';
import type Crowi from 'src/crowi';
import { createFederatedHandoffStore, type FederatedHandoffStore } from 'src/service/federated-handoff';
import { createLinkCompletionStore, type LinkCompletionStore, msFromRedisTimeReply } from 'src/service/link-completion';
import { isMultiInstanceDeclared } from 'src/util/env-schema';
import {
  buildHandoffCanonicalMessage,
  buildLinkCompletionUrl,
  buildLinkFailureUrl,
  buildLoginCompleteUrl,
  buildLoginErrorUrl,
  buildProviderCallbackUrl,
  buildRegistrationRedirectUrl,
  buildStartCanonicalMessage,
  computeJwkThumbprint,
  createFederatedAuthStateUtil,
  type FederatedAuthState,
  type FederatedAuthStateUtil,
  FederatedLinkCookieHeaderTooLargeError,
  type FederatedLinkState,
  FederatedLinkStateCookieTooLargeError,
  generateLinkStateValue,
  generateSignInStateValue,
  LINK_STATE_VALUE_PATTERN,
  LINK_STATE_VALUE_PREFIX,
  linkCookieNameFor,
  timingSafeEqualStrings,
  verifySenderProof,
} from 'src/util/federated-auth-state';
import { createJwtUtil } from 'src/util/jwt';
import { computePkceCodeChallengeS256 } from 'src/util/pkce';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { AUTH_REQUIRED_BODY, INTERNAL_ERROR_BODY, invalidRequestBody } from './_helpers/errors';
import { toAuthUser } from './_helpers/user-shape';

const debug = Debug('crowi:hono:handlers:federatedAuth');

type FederatedRouteDriver = OAuth2AuthDriver | OidcAuthDriver;

const isFederatedDriver = (driver: AuthDriver): driver is FederatedRouteDriver => driver.kind === 'oauth2' || driver.kind === 'oidc';

const PROVIDER_NOT_FOUND_BODY = { error: { code: 'NOT_FOUND' as const, message: 'Unknown or unconfigured provider' } };
const HANDOFF_INVALID_BODY = {
  error: { code: 'FEDERATED_HANDOFF_INVALID' as const, message: 'Handoff code is invalid, expired, or the sender proof did not verify' },
};
const HANDOFF_CONSUMED_BODY = {
  error: { code: 'FEDERATED_HANDOFF_CONSUMED' as const, message: 'Handoff code has already been used' },
};

/**
 * never-issued,
 * unconsumed-expired, and retention-expired all collapse to this ONE body,
 * both at the entry read and mid-replay (design decision 18). Also used for
 * a binding mismatch (wrong user/provider) — never distinguished from
 * "not found" so an attacker holding someone else's code learns nothing.
 */
const LINK_COMPLETION_NOT_FOUND_BODY = {
  error: {
    code: 'NOT_FOUND' as const,
    message: 'This link confirmation code is invalid or expired. Check the linked accounts list in Settings for the current status.',
  },
};
const LINK_COMPLETION_CONSUMED_BODY = {
  error: { code: 'LINK_COMPLETION_CONSUMED' as const, message: 'This link confirmation code has already been used' },
};
const FEDERATED_IDENTITY_IN_USE_BODY = {
  error: { code: 'FEDERATED_IDENTITY_IN_USE' as const, message: 'This provider account is already linked to a Crowi account' },
};
const FEDERATED_LINK_AUTH_STATE_CHANGED_BODY = {
  error: {
    code: 'FEDERATED_LINK_AUTH_STATE_CHANGED' as const,
    message: 'Your session changed since this link was started. Sign in again and retry.',
  },
};
const FEDERATED_LINK_NOT_LINKED_BODY = {
  error: { code: 'FEDERATED_LINK_NOT_LINKED' as const, message: 'This account is not linked' },
};

/**
 * Spec design decision 1 / AC-1: a PAT or OAuth access token is a valid
 * credential for the API but NOT for linking — linking is a session-level
 * account change, and a long-lived integration token must not be able to
 * attach a new sign-in method to its owner's account (nor read/unlink one).
 * 403 (not 401): the caller authenticated fine, this credential kind is
 * simply not permitted here. Module-level (not a `registerFederatedAuthRoutes`
 * closure) so every standalone handler function below (`startProviderLink`,
 * `getProviderLinkCompletion`, `completeProviderLink`, the inline unlink
 * handler) can use it independent of route registration.
 */
export const isWebSession = (c: Context<CrowiHonoBindings>): boolean => c.get('authContext')?.kind === 'web';

const NOT_WEB_SESSION_BODY = invalidRequestBody('this endpoint requires an interactive web session');

/** RFC 7636 §4.1 code_verifier — 32 random bytes, base64url (43 chars, within the 43-128 length range). */
function generatePkceCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * `openid-client` is published ESM-only (RFC-0014 phase 0 §"設計の主な判断"
 * — `@crowi/plugin-api`'s `registries/auth.ts` defers its own import the
 * same way). A static top-level `import` here would force Jest's CJS
 * transform to eagerly parse it for EVERY test file that merely imports
 * `hono/index.ts` (i.e. almost every integration test via
 * `src/test/setup.ts`), which fails outright ("Cannot use import statement
 * outside a module"). `buildAuthorizationUrl` / `authorizationCodeGrant`
 * are the only two functions actually needed here — PKCE generation is
 * hand-rolled above instead of using `openid-client`'s equivalents, so the
 * OAuth2 (non-OIDC) `/start` path never touches this import at all.
 */
async function loadOidcClient() {
  return import('openid-client');
}

/**
 * Exchange an authorization `code` at a plain OAuth2 (non-OIDC) driver's
 * `tokenUrl`. Hand-rolled (rather than `openid-client`) because
 * `OAuth2AuthDriver` deliberately has no `Configuration` — only OIDC
 * drivers carry discovery/JWKS machinery (RFC-0014 phase 0 §"設計の主な判断").
 * `client_secret_basic` (RFC 6749 §2.3.1) is used for client
 * authentication. Throws on any non-2xx response or a response missing
 * `access_token` — the caller maps that to the `exchange_failed` login
 * error without ever surfacing the underlying detail to the browser.
 */
async function exchangeOAuth2Code(
  driver: OAuth2AuthDriver,
  clientConfig: OAuthClientConfig,
  params: { code: string; redirectUri: string; codeVerifier?: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: clientConfig.clientId,
  });
  if (params.codeVerifier) body.set('code_verifier', params.codeVerifier);

  const basicAuth = Buffer.from(`${clientConfig.clientId}:${clientConfig.clientSecret}`).toString('base64');
  const res = await fetch(driver.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`oauth2 token endpoint responded with status ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== 'string') {
    throw new Error('oauth2 token endpoint response is missing access_token');
  }
  return {
    accessToken: json.access_token,
    tokenType: typeof json.token_type === 'string' ? json.token_type : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
  };
}

/**
 * Shared authorization-URL builder for
 * BOTH `/start` (sign-in) and `POST link-start`. Returns `null` for driver
 * discovery/config failure — callers map that to the existing 404
 * `PROVIDER_NOT_FOUND_BODY` (no cookie/state is ever issued for an
 * unusable driver).
 */
async function buildIdpAuthorizationUrl(input: {
  driver: FederatedRouteDriver;
  provider: string;
  callbackUrl: string;
  state: string;
  oidcNonce?: string;
  codeVerifier?: string;
}): Promise<string | null> {
  const { driver, provider, callbackUrl, state, oidcNonce, codeVerifier } = input;
  const usePkce = driver.kind === 'oidc' || driver.pkce === true;

  if (driver.kind === 'oidc') {
    let configuration: Awaited<ReturnType<typeof driver.getConfiguration>>;
    try {
      // `getConfiguration()` performs network discovery on a cache miss
      // (RFC-0014 phase 0 §"設計の主な判断") and can reject — it MUST stay
      // inside this try/catch (not awaited unguarded) so a discovery
      // failure maps to the same safe "provider unusable" response as the
      // synchronous null-config check below, instead of escaping to
      // Hono's global 500 handler.
      configuration = await driver.getConfiguration();
    } catch (err) {
      // Stable operation/provider/error-NAME only — this helper backs BOTH
      // ordinary sign-in `/start` and `POST link-start`, and `err.message`
      // from a plugin-authored `getConfiguration()` (network/discovery
      // failure text) is not guaranteed value-free.
      debug('oidc getConfiguration() failed at start for provider=%s: %s', provider, (err as Error).name);
      return null;
    }
    if (!configuration) return null;
    const { buildAuthorizationUrl } = await loadOidcClient();
    const params = new URLSearchParams({
      redirect_uri: callbackUrl,
      scope: driver.scopes.join(' '),
      state,
      nonce: oidcNonce as string,
      code_challenge: computePkceCodeChallengeS256(codeVerifier as string),
      code_challenge_method: 'S256',
    });
    const authorizeUrl = buildAuthorizationUrl(configuration, params);
    return authorizeUrl.toString();
  }

  const clientConfig = driver.getClientConfig();
  if (!clientConfig) return null;
  const authorizeUrl = new URL(driver.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientConfig.clientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  if (driver.scopes.length > 0) authorizeUrl.searchParams.set('scope', driver.scopes.join(' '));
  authorizeUrl.searchParams.set('state', state);
  if (usePkce) {
    authorizeUrl.searchParams.set('code_challenge', computePkceCodeChallengeS256(codeVerifier as string));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  }
  return authorizeUrl.toString();
}

/**
 * Shared nonce/PKCE/callback-URL assembly + authorization-URL build for
 * BOTH `/start` and `POST link-start` — the two call sites differ only in
 * which `state` generator produced `state`. Returns `null` on the same
 * driver discovery/config failure `buildIdpAuthorizationUrl` itself maps to
 * `null` — callers translate that to the existing 404 `PROVIDER_NOT_FOUND_BODY`.
 */
async function prepareIdpAuthorization(input: {
  driver: FederatedRouteDriver;
  provider: string;
  apiUrl: string;
  state: string;
}): Promise<{ authorizationUrl: string; oidcNonce: string | undefined; codeVerifier: string | undefined } | null> {
  const { driver, provider, apiUrl, state } = input;
  const oidcNonce = driver.kind === 'oidc' ? crypto.randomBytes(32).toString('base64url') : undefined;
  const usePkce = driver.kind === 'oidc' || driver.pkce === true;
  const codeVerifier = usePkce ? generatePkceCodeVerifier() : undefined;
  const callbackUrl = buildProviderCallbackUrl(apiUrl, provider);

  const authorizationUrl = await buildIdpAuthorizationUrl({ driver, provider, callbackUrl, state, oidcNonce, codeVerifier });
  if (!authorizationUrl) return null;
  return { authorizationUrl, oidcNonce, codeVerifier };
}

/**
 * The 4 ways a callback's OAuth2/OIDC
 * protocol exchange can fail, extracted from the exchange logic itself so
 * the same code serves both callers with DIFFERENT failure-disclosure
 * postures: ordinary sign-in maps each reason to its own existing
 * `buildLoginErrorUrl` redirect (unchanged wire behaviour — AC-3), while the
 * link branch collapses ALL FOUR into the one generic
 * `buildLinkFailureUrl` redirect (never reveals which protocol step
 * failed).
 */
type FederatedProfileExchangeFailure = 'invalid_state' | 'oidc_verification_failed' | 'exchange_failed' | 'profile_rejected';

type ExchangeProviderProfileOutcome = { ok: true; profile: AuthProfile } | { ok: false; reason: FederatedProfileExchangeFailure };

async function exchangeProviderProfile(input: {
  driver: FederatedRouteDriver;
  provider: string;
  callbackUrl: string;
  requestUrl: string;
  code: string;
  state: FederatedAuthState | FederatedLinkState;
}): Promise<ExchangeProviderProfileOutcome> {
  const { driver, provider, callbackUrl, requestUrl, code, state } = input;

  if (driver.kind === 'oidc') {
    try {
      const configuration = await driver.getConfiguration();
      if (!configuration) return { ok: false, reason: 'invalid_state' };

      // openid-client derives the token endpoint's `redirect_uri` by
      // stripping the query string off this URL — it MUST therefore be
      // the exact trusted callback URL (no query of its own), with the
      // real response query attached, not the internal (prefix-stripped)
      // request URL Hono sees.
      const currentUrl = new URL(callbackUrl);
      currentUrl.search = new URL(requestUrl).search;

      const { authorizationCodeGrant } = await loadOidcClient();
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        expectedState: state.state,
        expectedNonce: state.oidcNonce,
        pkceCodeVerifier: state.codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims) return { ok: false, reason: 'oidc_verification_failed' };

      if (driver.authorize) {
        const authResult = await driver.authorize(claims as Record<string, unknown>);
        if (!authResult.ok) return { ok: false, reason: 'profile_rejected' };
      }

      const mapped = driver.mapClaims ? driver.mapClaims(claims as Record<string, unknown>) : {};
      // RFC-0014 umbrella §"全フェーズに共通する確定事項": email is
      // required AND must be IdP-verified — Phase 2's JIT provisioning
      // trusts `profile.email` as already-verified. A driver providing
      // its OWN `mapClaims` owns this decision entirely (its contract,
      // Phase 0), but the DEFAULT (no `mapClaims`) mapping below must not
      // silently trust an unverified `claims.email` just because a driver
      // author forgot to reject it in `authorize` — only fall back to the
      // raw claim when the IdP itself asserts `email_verified === true`.
      const emailVerified = claims.email_verified === true;
      return {
        ok: true,
        profile: {
          providerUserId: mapped.providerUserId ?? String(claims.sub),
          email: mapped.email ?? (emailVerified && typeof claims.email === 'string' ? claims.email : undefined),
          name: mapped.name ?? (typeof claims.name === 'string' ? claims.name : undefined),
          imageUrl: mapped.imageUrl ?? (typeof claims.picture === 'string' ? claims.picture : undefined),
          extra: mapped.extra,
        },
      };
    } catch (err) {
      // Stable operation/provider/error-NAME only — see the analogous
      // comment on `buildIdpAuthorizationUrl` above; `openid-client`'s
      // thrown error text can embed callback query values (e.g. the IdP's
      // own error description).
      debug('oidc callback verification failed for provider=%s: %s', provider, (err as Error).name);
      return { ok: false, reason: 'oidc_verification_failed' };
    }
  }

  const clientConfig = driver.getClientConfig();
  if (!clientConfig) return { ok: false, reason: 'invalid_state' };

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeOAuth2Code(driver, clientConfig, { code, redirectUri: callbackUrl, codeVerifier: state.codeVerifier });
  } catch (err) {
    // Stable operation/provider/error-NAME only — see above.
    debug('oauth2 token exchange failed for provider=%s: %s', provider, (err as Error).name);
    return { ok: false, reason: 'exchange_failed' };
  }

  // `fetchProfile` is plugin-authored code — a REJECTED Promise (not
  // just an `{ ok: false }` result) must not escape to Hono's global
  // 500 handler either.
  let result: AuthVerifyResult;
  try {
    result = await driver.fetchProfile(tokens);
  } catch (err) {
    // Stable operation/provider/error-NAME only — see above.
    debug('oauth2 fetchProfile threw for provider=%s: %s', provider, (err as Error).name);
    return { ok: false, reason: 'profile_rejected' };
  }
  if (!result.ok) {
    // `result.reason` is a free-form string a plugin author supplies
    // (`AuthVerifyResult`'s contract, `@crowi/plugin-api`) — it can embed
    // the profile data (email, providerUserId) that made the driver reject
    // it, so it must never reach the log; a fixed, stable string instead.
    debug('oauth2 fetchProfile rejected provider=%s', provider);
    return { ok: false, reason: 'profile_rejected' };
  }
  return { ok: true, profile: result.profile };
}

/**
 * The store +
 * clock pair every link handler reads. `now()` is the linearization clock
 * `issueLink`/`verifyLink`/`store.issue` compare deadlines against — Redis
 * `TIME` in Redis mode, the same process's `Date.now()` in Map mode. Not a
 * store method itself (the store's own Redis backend independently calls
 * `MinimalLinkCompletionRedisClient#time()` for its own atomic decisions —
 * see `service/link-completion.ts`'s module doc comment); this is the
 * HANDLER-level clock used to stamp `stateExpiresAt` / verify cookie
 * expiry, which must agree with the store's own clock domain.
 */
export interface LinkCompletionRuntime {
  store: LinkCompletionStore;
  now(): Promise<number>;
}

/** Constructs a fresh `LinkCompletionRuntime` — called AT MOST ONCE per registered app (memoized by `registerFederatedAuthRoutes`, see `getLinkCompletionRuntime` below). */
export type LinkCompletionRuntimeFactory = () => Promise<LinkCompletionRuntime>;

/**
 * Default runtime
 * factory: `CROWI_MULTI_INSTANCE` declared -> Redis required (the store
 * itself throws via `requireRedis: true` when `crowi.redis` is unset,
 * which the caller maps to a generic 500); undeclared -> Redis when
 * available, else the in-memory Map fallback. A deployment that never
 * calls a link route never constructs this (lazy, closure-memoized).
 */
function createDefaultLinkCompletionRuntimeFactory(crowi: Crowi): LinkCompletionRuntimeFactory {
  return async () => {
    const keyspace = resolveRedisKeyspaceIfEnabled(crowi);
    const store = createLinkCompletionStore({ redisClient: crowi.redis, keyspace, requireRedis: isMultiInstanceDeclared(process.env) });
    const usingRedis = keyspace !== undefined;
    return {
      store,
      now: usingRedis ? async () => msFromRedisTimeReply(await crowi.redis.time()) : async () => Date.now(),
    };
  };
}

export interface RegisterFederatedAuthRoutesOptions {
  /** Test seam / Phase 2+ swap point — defaults to Phase 1's always-decline terminal. */
  terminal?: FederatedProfileTerminal;
  /**
   * Test seam / shared-instance injection point — defaults to a fresh
   * `createFederatedHandoffStore(...)`. Production callers (`hono/index.ts`)
   * MUST pass the SAME instance also given to `registerFederatedRegistrationRoutes`
   * — see that call site's comment for why (in-memory backend correctness).
   */
  handoffStore?: FederatedHandoffStore;
  /** Test seam — defaults to `createAuthProviderLinkingTerminal(crowi)` (RFC-0014 phase 3). */
  linkingTerminal?: AuthProviderLinkingTerminal;
  /** Test seam — defaults to `createDefaultLinkCompletionRuntimeFactory(crowi)`. Memoized to at most one call regardless of override. */
  linkCompletionRuntimeFactory?: LinkCompletionRuntimeFactory;
  /** Test seam — defaults to `createFederatedAuthStateUtil(crowi)`. */
  stateUtil?: FederatedAuthStateUtil;
}

/**
 * Shared dependency bag for every route handler in this file (RFC-0014
 * phase 1 implementation map — each handler is a standalone exported
 * symbol, not a private closure inline in `registerFederatedAuthRoutes`, so
 * each can be constructed/tested independent of the full route
 * registration).
 */
export interface FederatedAuthRouteDeps {
  crowi: Crowi;
  stateUtil: FederatedAuthStateUtil;
  handoffStore: FederatedHandoffStore;
  terminal: FederatedProfileTerminal;
  /** The terminal the confirmation-POST-side link branch calls after its fresh-User fence passes. */
  linkingTerminal: AuthProviderLinkingTerminal;
  /** Enabled = registered, oauth2/oidc kind, and currently configured (design decision 1). */
  getEnabledDriver: (name: string) => FederatedRouteDriver | null;
  /** Memoized accessor; every link handler calls this instead of constructing its own runtime. */
  getLinkCompletionRuntime: () => Promise<LinkCompletionRuntime>;
}

/**
 * `GET /auth/providers/{name}/start` — validates the sender proof, mints the
 * signed state cookie (+ OIDC nonce / PKCE verifier when applicable), and
 * redirects the browser to the provider's authorize endpoint. Public
 * sign-in ONLY — the retired `link=1`/`link_grant` mode is gone entirely;
 * a raw `link` query key (any value) is rejected outright rather than
 * silently downgraded to sign-in.
 */
export function buildProviderRedirect(deps: FederatedAuthRouteDeps): RouteHandler<typeof startFederatedProviderRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, getEnabledDriver } = deps;
  return async (c) => {
    // the raw URL
    // is inspected (not `c.req.valid('query')`, which the contract no
    // longer even types a `link` field on) so ANY value — not just the
    // old `link=1` — is rejected, rather than silently accepted as an
    // unrecognised/ignored query parameter.
    if (c.req.query('link') !== undefined) {
      return c.json(invalidRequestBody('the link query parameter is no longer supported — start a link from the account settings page instead'), 400);
    }

    const urls = crowi.getFederatedAuthPublicUrls();
    const { name } = c.req.valid('param');
    const driver = urls ? getEnabledDriver(name) : null;
    if (!urls || !driver) return c.json(PROVIDER_NOT_FOUND_BODY, 404);

    const { continue: continuePath, handoff_jwk: handoffJwkB64, handoff_proof: handoffProofB64 } = c.req.valid('query');

    let publicJwk: webcrypto.JsonWebKey;
    try {
      publicJwk = JSON.parse(Buffer.from(handoffJwkB64, 'base64url').toString('utf8'));
    } catch {
      return c.json(invalidRequestBody('handoff_jwk is not valid base64url(JSON)'), 400);
    }
    if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') {
      return c.json(invalidRequestBody('handoff_jwk must be a P-256 EC public key'), 400);
    }

    const startMessage = buildStartCanonicalMessage(urls.apiUrl, name, continuePath, handoffJwkB64);
    const proofOk = await verifySenderProof({ publicJwk, signature: handoffProofB64 }, startMessage);
    if (!proofOk) {
      return c.json(invalidRequestBody('handoff_proof did not verify against handoff_jwk'), 400);
    }
    const handoffJkt = computeJwkThumbprint(publicJwk);

    const state = generateSignInStateValue();
    const prepared = await prepareIdpAuthorization({ driver, provider: name, apiUrl: urls.apiUrl, state });
    if (!prepared) return c.json(PROVIDER_NOT_FOUND_BODY, 404);
    const { authorizationUrl, oidcNonce, codeVerifier } = prepared;

    const cookieValue = stateUtil.issue({ state, provider: name, continuePath, codeVerifier, oidcNonce, handoffJkt });
    setCookie(c, stateUtil.cookieName, cookieValue, stateUtil.cookieOptions);

    return c.redirect(authorizationUrl, 302);
  };
}

/**
 * The callback's link branch.
 * Verifies the flow-specific state cookie, completes the OAuth2/OIDC
 * protocol exchange, and — on success — asks the shared
 * `LinkCompletionRuntime` store to atomically issue a one-time completion
 * code. Deliberately reads/writes NOTHING in `User` / `UserIdentity` /
 * `PendingAuthRegistration`, and never calls `linkingTerminal` — the DB
 * mutation happens later, at the authenticated confirmation POST, after a
 * fresh identity/session fence (`completeProviderLink` below).
 */
async function completeLinkCallback(
  c: Context<CrowiHonoBindings>,
  deps: FederatedAuthRouteDeps,
  input: {
    name: string;
    returnedState: string;
    code: string | undefined;
    error: string | undefined;
  },
): Promise<Response> {
  const { crowi, stateUtil, getEnabledDriver, getLinkCompletionRuntime } = deps;
  const { name, returnedState, code, error } = input;

  // resolved
  // BEFORE touching any cookie at all: the link branch must never read or
  // delete the unrelated fixed sign-in cookie (AC-5), so provider/urls
  // resolution — and even the state-pattern check — happen first,
  // independent of the ordinary sign-in branch's own cookie-first order.
  const urls = crowi.getFederatedAuthPublicUrls();
  const driver = urls ? getEnabledDriver(name) : null;
  if (!urls || !driver) {
    return c.json(PROVIDER_NOT_FOUND_BODY, 404);
  }
  const fail = () => c.redirect(buildLinkFailureUrl(urls.webUrl, name), 302);

  // A full pattern mismatch fails WITHOUT ever touching the fixed sign-in
  // cookie (AC-5): the namespace prefix alone routed us here, but only a
  // fully well-formed state derives a cookie name to look up at all.
  if (!LINK_STATE_VALUE_PATTERN.test(returnedState)) {
    return fail();
  }
  const linkCookieName = linkCookieNameFor(returnedState) as string;
  const linkCookieValue = getCookie(c, linkCookieName);
  if (!linkCookieValue) {
    // No link cookie for this state — fail without reading/deleting the
    // UNRELATED fixed sign-in cookie (AC-5: an in-flight ordinary sign-in
    // on the same browser must remain completable).
    return fail();
  }
  deleteCookie(c, linkCookieName, { path: deps.stateUtil.linkCookieOptions.path });

  let runtime: LinkCompletionRuntime;
  let now: number;
  try {
    runtime = await getLinkCompletionRuntime();
    now = await runtime.now();
  } catch (err) {
    debug('link callback: runtime resolution failed for provider=%s: %s', name, (err as Error).name);
    return c.json(INTERNAL_ERROR_BODY, 500);
  }

  const linkState = stateUtil.verifyLink(linkCookieValue, { state: returnedState, provider: name }, now);
  if (!linkState) {
    return fail();
  }

  if (error || !code) {
    return fail();
  }

  const exchangeResult = await exchangeProviderProfile({
    driver,
    provider: name,
    callbackUrl: buildProviderCallbackUrl(urls.apiUrl, name),
    requestUrl: c.req.url,
    code,
    state: linkState,
  });
  if (!exchangeResult.ok) {
    return fail();
  }
  const profile = exchangeResult.profile;

  try {
    const issueOutcome = await runtime.store.issue({
      state: returnedState,
      stateExpiresAt: linkState.expiresAt,
      userId: linkState.userId,
      authVersion: linkState.authVersion,
      provider: name,
      providerUserId: profile.providerUserId,
      accountLabel: profile.email,
    });
    if (!issueOutcome.ok) {
      return fail();
    }
    return c.redirect(buildLinkCompletionUrl(urls.webUrl, name, issueOutcome.code), 302);
  } catch (err) {
    debug('link callback: completion issue failed for provider=%s: %s', name, (err as Error).name);
    return c.json(INTERNAL_ERROR_BODY, 500);
  }
}

/**
 * `GET /auth/providers/{name}/callback` — the IdP redirect target. Branches
 * on the query `state`'s namespace BEFORE touching the fixed sign-in cookie
 * at all: a
 * `crowilnk_`-prefixed state routes to `completeLinkCallback` above; every
 * other value follows the unchanged sign-in path (state cookie, OAuth2/OIDC
 * exchange via the shared `exchangeProviderProfile`, `FederatedProfileTerminal`,
 * sender-constrained handoff code).
 */
export function completeFederatedCallback(deps: FederatedAuthRouteDeps): RouteHandler<typeof callbackFederatedProviderRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, terminal, handoffStore, getEnabledDriver } = deps;
  return async (c) => {
    const { name } = c.req.valid('param');
    const { code, state: returnedState, error } = c.req.valid('query');

    // the
    // query state's reserved namespace decides the branch BEFORE anything
    // else runs, so a link-branch callback (see `completeLinkCallback`)
    // never reads/deletes the unrelated fixed sign-in cookie below (AC-5).
    if (returnedState?.startsWith(LINK_STATE_VALUE_PREFIX)) {
      return completeLinkCallback(c, deps, { name, returnedState, code, error });
    }

    // Read + immediately clear the state cookie, BEFORE any other check —
    // it must be consumed exactly once regardless of outcome (AC-2).
    // Unchanged ordering from RFC-0014 phase 1: this happens even before
    // the driver-enablement 404 below (a regression test pins this).
    const rawCookie = getCookie(c, stateUtil.cookieName);
    deleteCookie(c, stateUtil.cookieName, { path: stateUtil.cookieOptions.path });

    const urls = crowi.getFederatedAuthPublicUrls();
    // Driver enablement is resolved BEFORE state validation — mirrors
    // `/start`'s own `!urls || !driver` check. An unknown/unconfigured/
    // credential-kind provider name (or unresolvable trusted origins) is
    // a 404 per the contract, never folded into the generic
    // `invalid_state` login redirect (which requires a resolved `driver`
    // to even reach — see design decision 1).
    const driver = urls ? getEnabledDriver(name) : null;
    if (!urls || !driver) {
      return c.json(PROVIDER_NOT_FOUND_BODY, 404);
    }

    const state = stateUtil.verify(rawCookie, name);
    // Cookie signature/expiry/provider (all inside `verify`) PLUS a
    // constant-time comparison against the IdP-echoed `state` query
    // parameter — the classic OAuth "state" CSRF defense, redundant with
    // (not replaced by) the cookie's own HMAC signature and
    // `SameSite=Lax` scoping (RFC-0014 phase 1 §"設計の主な判断" flow
    // step 3).
    if (!state || !returnedState || !timingSafeEqualStrings(state.state, returnedState)) {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, 'invalid_state'), 302);
    }

    if (error || !code) {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, 'idp_error'), 302);
    }

    const exchangeResult = await exchangeProviderProfile({
      driver,
      provider: name,
      callbackUrl: buildProviderCallbackUrl(urls.apiUrl, name),
      requestUrl: c.req.url,
      code,
      state,
    });
    if (!exchangeResult.ok) {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, exchangeResult.reason), 302);
    }
    const profile = exchangeResult.profile;

    const terminalResult = await terminal.resolve({ provider: name, profile, providerLabel: driver.buttonLabel, handoffJkt: state.handoffJkt });
    if (terminalResult.kind === 'redirect_error') {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, terminalResult.code), 302);
    }
    if (terminalResult.kind === 'registration') {
      // RFC-0014 phase 2 — unknown-but-verified identity: no User was
      // created. Hand the browser to the federated registration screen
      // instead of issuing a handoff code.
      return c.redirect(buildRegistrationRedirectUrl(urls.webUrl, terminalResult.token), 302);
    }

    const User = crowi.model('User');
    const activeUser = terminalResult.user;
    if (activeUser.status !== User.STATUS_ACTIVE) {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, 'account_inactive'), 302);
    }

    const handoffCode = await handoffStore.issue({
      userId: activeUser._id.toString(),
      handoffJkt: state.handoffJkt,
      // RFC-0014 phase 3 (AC-7): pin the identity this sign-in was resolved
      // through, so `/auth/handoff` can re-check it still exists right
      // before minting tokens — an unlink between here and there must not
      // still yield a session for the disconnected provider.
      identityFence: { userId: activeUser._id.toString(), provider: name, providerUserId: profile.providerUserId },
    });
    return c.redirect(buildLoginCompleteUrl(urls.webUrl, handoffCode, state.continuePath), 302);
  };
}

/**
 * `POST /auth/providers/{name}/link-start` — stage 1. Mints the IdP
 * authorization URL + a flow-specific, admission-pruned link-state cookie
 * for the current web session. See the spec's "1. 連携開始" control-flow
 * section for the exact check order this mirrors.
 */
export function startProviderLink(deps: FederatedAuthRouteDeps): RouteHandler<typeof startProviderLinkRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, getEnabledDriver, getLinkCompletionRuntime } = deps;
  return async (c) => {
    if (!isWebSession(c)) return c.json(NOT_WEB_SESSION_BODY, 403);
    const user = c.get('user');
    if (!user) return c.json(AUTH_REQUIRED_BODY, 401);

    const { name } = c.req.valid('param');
    const urls = crowi.getFederatedAuthPublicUrls();
    const driver = urls ? getEnabledDriver(name) : null;
    if (!urls || !driver) return c.json(PROVIDER_NOT_FOUND_BODY, 404);

    let runtime: LinkCompletionRuntime;
    try {
      runtime = await getLinkCompletionRuntime();
    } catch (err) {
      debug('link-start: failed to resolve link completion runtime for provider=%s: %s', name, (err as Error).name);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }

    const state = generateLinkStateValue();
    const prepared = await prepareIdpAuthorization({ driver, provider: name, apiUrl: urls.apiUrl, state });
    if (!prepared) return c.json(PROVIDER_NOT_FOUND_BODY, 404);
    const { authorizationUrl, oidcNonce, codeVerifier } = prepared;

    let now: number;
    try {
      now = await runtime.now();
    } catch (err) {
      debug('link-start: failed to read the link completion clock for provider=%s: %s', name, (err as Error).name);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }

    let cookieValue: string;
    try {
      cookieValue = stateUtil.issueLink(
        { flow: 'link', state, provider: name, userId: user._id.toString(), authVersion: user.authVersion ?? 0, codeVerifier, oidcNonce },
        now,
      );
    } catch (err) {
      if (err instanceof FederatedLinkStateCookieTooLargeError) {
        return c.json(invalidRequestBody('link state is too large to set as a cookie'), 400);
      }
      throw err;
    }

    // `generateLinkStateValue()` always matches `LINK_STATE_VALUE_PATTERN` — unreachable in practice, but fail closed rather than setting an unnamed cookie.
    const cookieName = linkCookieNameFor(state);
    if (!cookieName) {
      return c.json(INTERNAL_ERROR_BODY, 500);
    }

    let prunePlan: ReturnType<FederatedAuthStateUtil['planLinkCookiePrune']>;
    try {
      prunePlan = stateUtil.planLinkCookiePrune(c.req.header('cookie'), cookieName, cookieValue, now);
    } catch (err) {
      if (err instanceof FederatedLinkCookieHeaderTooLargeError) {
        return c.json(invalidRequestBody('too many pending link flows for this browser — try again shortly'), 400);
      }
      throw err;
    }

    for (const expireName of prunePlan.expireCookieNames) {
      deleteCookie(c, expireName, { path: stateUtil.linkCookieOptions.path });
    }
    setCookie(c, cookieName, cookieValue, stateUtil.linkCookieOptions);

    return c.json({ authorizationUrl }, 200);
  };
}

/**
 * `GET /auth/providers/{name}/link-completions/{code}` — stage 3a.
 * Non-destructive confirmation read: binds on user/provider/authVersion,
 * never mutates the store.
 */
export function getProviderLinkCompletion(deps: FederatedAuthRouteDeps): RouteHandler<typeof getProviderLinkCompletionRoute, CrowiHonoBindings> {
  const { getLinkCompletionRuntime } = deps;
  return async (c) => {
    if (!isWebSession(c)) return c.json(NOT_WEB_SESSION_BODY, 403);
    const user = c.get('user');
    if (!user) return c.json(AUTH_REQUIRED_BODY, 401);

    const { name, code } = c.req.valid('param');

    try {
      const runtime = await getLinkCompletionRuntime();
      const record = await runtime.store.find(code);
      if (!record || record.userId !== user._id.toString() || record.provider !== name || record.authVersion !== (user.authVersion ?? 0)) {
        return c.json(LINK_COMPLETION_NOT_FOUND_BODY, 404);
      }
      if (record.consumedAt != null) {
        return c.json(LINK_COMPLETION_CONSUMED_BODY, 409);
      }
      const body = record.accountLabel !== undefined ? { provider: record.provider, accountLabel: record.accountLabel } : { provider: record.provider };
      return c.json(body, 200);
    } catch (err) {
      debug('link completion GET failed for provider=%s: %s', name, (err as Error).name);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}

/**
 * `POST /auth/providers/{name}/link-completions/{code}` — stage 3b, the
 * terminal step. Order mirrors the spec's "4. 確定 winner" flow exactly:
 * binding pre-check (no consume yet) -> atomic `consumeVerified` -> fresh
 * `User` fence (winner only) -> `linkingTerminal.link(...)`. An
 * already-consumed outcome re-derives its result from the DB
 * (`resolveAuthProviderLinkReplay`) instead of attempting a second consume.
 */
export function completeProviderLink(deps: FederatedAuthRouteDeps): RouteHandler<typeof completeProviderLinkRoute, CrowiHonoBindings> {
  const { crowi, linkingTerminal, getLinkCompletionRuntime } = deps;
  return async (c) => {
    if (!isWebSession(c)) return c.json(NOT_WEB_SESSION_BODY, 403);
    const user = c.get('user');
    if (!user) return c.json(AUTH_REQUIRED_BODY, 401);

    const { name, code } = c.req.valid('param');
    const userId = user._id.toString();

    try {
      const runtime = await getLinkCompletionRuntime();

      // Binding pre-check BEFORE any consume attempt — another user's
      // session can never burn a victim's code (spec §"4. 確定 winner" 1).
      const preRecord = await runtime.store.find(code);
      if (!preRecord || preRecord.userId !== userId || preRecord.provider !== name) {
        return c.json(LINK_COMPLETION_NOT_FOUND_BODY, 404);
      }

      const consumeOutcome = await runtime.store.consumeVerified(code);
      if (!consumeOutcome.ok) {
        if (consumeOutcome.reason === 'not_found') {
          return c.json(LINK_COMPLETION_NOT_FOUND_BODY, 404);
        }
        // already_consumed — re-derive the replay result from the DB (spec §"5. already-consumed replay の再導出").
        const replayRecord = await runtime.store.find(code);
        if (!replayRecord) {
          return c.json(LINK_COMPLETION_NOT_FOUND_BODY, 404);
        }
        if (replayRecord.userId !== userId || replayRecord.provider !== name) {
          return c.json(LINK_COMPLETION_NOT_FOUND_BODY, 404);
        }
        const replay = await resolveAuthProviderLinkReplay(crowi, {
          userId: replayRecord.userId,
          provider: replayRecord.provider,
          providerUserId: replayRecord.providerUserId,
        });
        if (replay.kind === 'linked') return c.json({ result: 'linked' as const }, 200);
        if (replay.kind === 'not_linked') return c.json(FEDERATED_LINK_NOT_LINKED_BODY, 409);
        return c.json(FEDERATED_IDENTITY_IN_USE_BODY, 409);
      }

      const record = consumeOutcome.record;
      const User = crowi.model('User');
      const freshUser = await User.findById(record.userId).select('status authVersion');
      if (!freshUser || freshUser.status !== User.STATUS_ACTIVE || (freshUser.authVersion ?? 0) !== record.authVersion) {
        return c.json(FEDERATED_LINK_AUTH_STATE_CHANGED_BODY, 409);
      }

      const outcome = await linkingTerminal.link({ userId: record.userId, provider: record.provider, providerUserId: record.providerUserId });
      if (outcome.kind === 'linked' || outcome.kind === 'already_linked_here') {
        return c.json({ result: 'linked' as const }, 200);
      }
      if (outcome.kind === 'owned_by_other_user' || outcome.kind === 'provider_slot_taken') {
        return c.json(FEDERATED_IDENTITY_IN_USE_BODY, 409);
      }
      // outcome.kind === 'failed' — infra contention, never a compensating delete of anything (nothing was inserted).
      return c.json(INTERNAL_ERROR_BODY, 500);
    } catch (err) {
      debug('link completion POST failed for provider=%s: %s', name, (err as Error).name);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}

export const registerFederatedAuthRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(
  app: E,
  crowi: Crowi,
  options: RegisterFederatedAuthRoutesOptions = {},
) => {
  const terminal = options.terminal ?? createUnavailableFederatedProfileTerminal();
  const stateUtil = options.stateUtil ?? createFederatedAuthStateUtil(crowi);
  const handoffStore =
    options.handoffStore ??
    createFederatedHandoffStore({
      redisClient: crowi.redis,
      keyspace: resolveRedisKeyspaceIfEnabled(crowi),
    });
  const linkingTerminal = options.linkingTerminal ?? createAuthProviderLinkingTerminal(crowi);
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  const getEnabledDriver = (name: string): FederatedRouteDriver | null => {
    const driver = crowi.getPlugins().auth.get(name);
    if (!driver || !isFederatedDriver(driver)) return null;
    if (driver.getClientConfig() == null) return null;
    return driver;
  };

  // lazy,
  // closure-memoized to at most ONE construction for the lifetime of this
  // registered app: a deployment that never calls a link route never pays
  // the (possible Redis-availability-checking) construction cost, and
  // every one of the 4 link handlers below observes the SAME store/clock
  // instance.
  const linkCompletionRuntimeFactory = options.linkCompletionRuntimeFactory ?? createDefaultLinkCompletionRuntimeFactory(crowi);
  let linkCompletionRuntimePromise: Promise<LinkCompletionRuntime> | null = null;
  const getLinkCompletionRuntime = (): Promise<LinkCompletionRuntime> => {
    if (!linkCompletionRuntimePromise) {
      linkCompletionRuntimePromise = linkCompletionRuntimeFactory();
    }
    return linkCompletionRuntimePromise;
  };

  const deps: FederatedAuthRouteDeps = { crowi, stateUtil, handoffStore, terminal, linkingTerminal, getEnabledDriver, getLinkCompletionRuntime };

  const jwtAuth = createJwtAuth(crowi);
  app.use('/auth/providers/identities', jwtAuth);
  app.use('/auth/providers/:name/identity', jwtAuth);
  // Every link route requires a web
  // session. Installed via `app.use(...)` BEFORE `.openapi(...)` route
  // registration below, so credential resolution (and any PAT `lastUsedAt`
  // bump) always runs before this route's own Zod validation — an
  // unauthenticated/malformed-credential request never reaches the
  // handler, regardless of whether `{code}` is well-formed.
  app.use('/auth/providers/:name/link-start', jwtAuth);
  app.use('/auth/providers/:name/link-completions/:code', jwtAuth);

  return app
    .openapi(listFederatedProvidersRoute, async (c) => {
      const urls = crowi.getFederatedAuthPublicUrls();
      if (!urls) return c.json({ providers: [] }, 200);

      const providers = crowi
        .getPlugins()
        .auth.list()
        .map(({ driverName }) => driverName)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, driver: getEnabledDriver(name) }))
        .filter((entry): entry is { name: string; driver: FederatedRouteDriver } => entry.driver != null)
        .map(({ name, driver }) => ({ name, buttonLabel: driver.buttonLabel, iconUrl: driver.iconUrl }));

      return c.json({ providers }, 200);
    })
    .openapi(startFederatedProviderRoute, buildProviderRedirect(deps))
    .openapi(callbackFederatedProviderRoute, completeFederatedCallback(deps))
    .openapi(federatedHandoffRoute, async (c) => {
      const urls = crowi.getFederatedAuthPublicUrls();
      if (!urls) return c.json(HANDOFF_INVALID_BODY, 401);

      const { code, proof } = c.req.valid('json');

      try {
        const record = await handoffStore.find(code);
        if (!record) return c.json(HANDOFF_INVALID_BODY, 401);

        const proofJkt = computeJwkThumbprint(proof.publicJwk);
        if (!timingSafeEqualStrings(proofJkt, record.handoffJkt)) {
          return c.json(HANDOFF_INVALID_BODY, 401);
        }

        const handoffMessage = buildHandoffCanonicalMessage(urls.apiUrl, code);
        const proofOk = await verifySenderProof(proof, handoffMessage);
        if (!proofOk) return c.json(HANDOFF_INVALID_BODY, 401);

        // Only reachable once the sender proof has verified — see the
        // module doc comment for why `consumeVerified` itself performs no
        // proof/JKT check.
        const outcome = await handoffStore.consumeVerified(code);
        if (!outcome.ok) {
          // `not_found` also covers a code that expired in the window
          // between this handler's own `find()` above and this atomic
          // consume (proof verification takes real time) — that is NOT a
          // replay and must map to the same 401 as `find()` returning
          // `null`, not the 409 reserved for a genuine already-consumed
          // race (AC-5; see FederatedHandoffConsumeOutcome's doc comment).
          return c.json(
            outcome.reason === 'already_consumed' ? HANDOFF_CONSUMED_BODY : HANDOFF_INVALID_BODY,
            outcome.reason === 'already_consumed' ? 409 : 401,
          );
        }

        const user = await User.findById(outcome.record.userId);
        if (!user || user.status !== User.STATUS_ACTIVE) {
          return c.json(HANDOFF_INVALID_BODY, 401);
        }

        // RFC-0014 phase 3 (AC-7) — the identity fence, checked as late as
        // possible: `createJwtAuth` validates only the JWT's user and
        // `authVersion` and knows nothing about identity membership, so
        // without this a code minted before an unlink would still mint a
        // full session for the provider the user just disconnected.
        // Reported as the SAME generic invalid-handoff error as every other
        // failure here — a distinct code would tell the caller that their
        // code was otherwise perfectly valid.
        const UserIdentity = crowi.model('UserIdentity');
        const fence = outcome.record.identityFence;
        const identityStillLinked = await UserIdentity.exists({ userId: fence.userId, provider: fence.provider, providerUserId: fence.providerUserId });
        if (!identityStillLinked) {
          return c.json(HANDOFF_INVALID_BODY, 401);
        }

        const tokens = jwtUtil.generateTokens(user);
        return c.json({ ...tokens, user: toAuthUser(user) }, 200);
      } catch (err) {
        debug('handoff failed: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(listLinkedAuthProvidersRoute, async (c) => {
      const user = c.get('user');
      if (!user) return c.json(AUTH_REQUIRED_BODY, 401);

      try {
        const UserIdentity = crowi.model('UserIdentity');
        const rows = await UserIdentity.find({ userId: user._id });
        // Slugs only — the settings screen decides Link vs Unlink from
        // this and needs nothing else. See the response schema's comment.
        const identities = rows.map((row) => ({ provider: row.provider })).sort((a, b) => a.provider.localeCompare(b.provider));
        return c.json({ identities }, 200);
      } catch (err) {
        debug('listing linked identities failed: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(startProviderLinkRoute, startProviderLink(deps))
    .openapi(getProviderLinkCompletionRoute, getProviderLinkCompletion(deps))
    .openapi(completeProviderLinkRoute, completeProviderLink(deps))
    .openapi(unlinkAuthProviderRoute, async (c) => {
      const { name } = c.req.valid('param');
      if (!isWebSession(c)) return c.json(NOT_WEB_SESSION_BODY, 403);

      const user = c.get('user');
      if (!user) return c.json(AUTH_REQUIRED_BODY, 401);

      try {
        const outcome = await unlinkFederatedIdentity(crowi, user, name);
        switch (outcome.kind) {
          case 'unlinked':
            return c.body(null, 204);
          case 'not_linked':
            return c.json({ error: { code: 'NOT_FOUND' as const, message: 'No identity is linked for this provider' } }, 404);
          case 'password_auth_disabled':
            return c.json(
              {
                error: {
                  code: 'FEDERATED_UNLINK_DISABLED' as const,
                  message: 'Password sign-in is disabled on this instance, so provider accounts cannot be disconnected',
                },
              },
              409,
            );
          case 'password_required':
            return c.json({ error: { code: 'PASSWORD_REQUIRED' as const, message: 'Set a password before disconnecting this provider account' } }, 409);
          default: {
            const exhaustive: never = outcome;
            throw new Error(`unlinkAuthProvider: unhandled outcome ${JSON.stringify(exhaustive)}`);
          }
        }
      } catch (err) {
        debug('unlink failed: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
