/**
 * RFC-0014 phase 1 — federated (OAuth2/OIDC) sign-in flow skeleton.
 *
 *   GET  /auth/providers                — public, enabled provider list
 *   GET  /auth/providers/{name}/start   — public, top-level-navigation redirect to the IdP
 *   GET  /auth/providers/{name}/callback — public, IdP redirect target
 *   POST /auth/handoff                  — public, sender-constrained code -> session tokens
 *
 * See `.feature-state/specs/feature-auth-google-phase1-flow-skeleton.md`
 * for the full design (state cookie / PKCE / sender-constrained handoff
 * threat model). Phase 1 wires the OAuth2/OIDC PROTOCOL only —
 * provisioning/linking are `FederatedProfileTerminal`'s job, and Phase 1's
 * own terminal (`createUnavailableFederatedProfileTerminal`) never reads
 * or writes `User`/`UserIdentity`.
 *
 * The few `terminalResult.kind === 'registration'` / `providerLabel` /
 * `handoffJkt` / shared-`handoffStore` touches below are Phase 2's, added at
 * `completeFederatedCallback`'s single `terminal.resolve(...)` call site and
 * `registerFederatedAuthRoutes`'s options — the OAuth2/OIDC protocol code
 * itself (state cookie, PKCE, id_token verification, JWT bridge) is
 * untouched. See `src/auth/federated-profile-terminal.ts`'s header for why
 * this is the exact extension point the umbrella spec's phase-1 row names
 * ("provisioning と linking の分岐先はインターフェースのみ"), and phase 2's
 * own design decision 8 for why the handoff store must be the SAME shared
 * instance.
 */
import {
  callbackFederatedProviderRoute,
  createAuthProviderLinkGrantRoute,
  federatedHandoffRoute,
  listFederatedProvidersRoute,
  startFederatedProviderRoute,
  unlinkAuthProviderRoute,
} from '@crowi/api-contract';
import type { AuthDriver, AuthProfile, AuthVerifyResult, OAuth2AuthDriver, OAuthClientConfig, OAuthTokens, OidcAuthDriver } from '@crowi/plugin-api';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import crypto from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import Debug from 'debug';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Context } from 'hono';

import type Crowi from 'src/crowi';
import {
  type AuthProviderLinkingTerminal,
  createAuthProviderLinkingTerminal,
  createLinkGrantStore,
  type LinkGrantStore,
  unlinkFederatedIdentity,
} from 'src/auth/auth-provider-linking';
import { createUnavailableFederatedProfileTerminal, type FederatedProfileTerminal } from 'src/auth/federated-profile-terminal';
import { createFederatedHandoffStore, type FederatedHandoffStore } from 'src/service/federated-handoff';
import { createJwtUtil } from 'src/util/jwt';
import {
  buildHandoffCanonicalMessage,
  buildLinkSettingsUrl,
  buildLoginCompleteUrl,
  buildLoginErrorUrl,
  buildProviderCallbackUrl,
  buildRegistrationRedirectUrl,
  buildStartCanonicalMessage,
  computeJwkThumbprint,
  createFederatedAuthStateUtil,
  type FederatedAuthStateUtil,
  timingSafeEqualStrings,
  verifySenderProof,
} from 'src/util/federated-auth-state';
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
  /** Test seam — defaults to a fresh `createLinkGrantStore(...)` (RFC-0014 phase 3). */
  linkGrantStore?: LinkGrantStore;
  /** Test seam — defaults to `createAuthProviderLinkingTerminal(crowi)` (RFC-0014 phase 3). */
  linkingTerminal?: AuthProviderLinkingTerminal;
}

/**
 * Shared dependency bag for the `/start` and `/callback` route handlers
 * (RFC-0014 phase 1 implementation map — `buildProviderRedirect` and
 * `completeFederatedCallback` are standalone exported symbols, not private
 * closures inline in `registerFederatedAuthRoutes`, so each can be
 * constructed/tested independent of the full route registration).
 */
export interface FederatedAuthRouteDeps {
  crowi: Crowi;
  stateUtil: FederatedAuthStateUtil;
  handoffStore: FederatedHandoffStore;
  terminal: FederatedProfileTerminal;
  /** RFC-0014 phase 3 — the short-lived server-side binding a `link=1` start consumes. */
  linkGrantStore: LinkGrantStore;
  /** RFC-0014 phase 3 — the callback-side link branch, used INSTEAD of `terminal` when the signed state carries a link target. */
  linkingTerminal: AuthProviderLinkingTerminal;
  /** Enabled = registered, oauth2/oidc kind, and currently configured (design decision 1). */
  getEnabledDriver: (name: string) => FederatedRouteDriver | null;
}

/**
 * `GET /auth/providers/{name}/start` — validates the sender proof, mints the
 * signed state cookie (+ OIDC nonce / PKCE verifier when applicable), and
 * redirects the browser to the provider's authorize endpoint.
 */
export function buildProviderRedirect(deps: FederatedAuthRouteDeps): RouteHandler<typeof startFederatedProviderRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, getEnabledDriver, linkGrantStore } = deps;
  return async (c) => {
    const urls = crowi.getFederatedAuthPublicUrls();
    const { name } = c.req.valid('param');
    const driver = urls ? getEnabledDriver(name) : null;
    if (!urls || !driver) return c.json(PROVIDER_NOT_FOUND_BODY, 404);

    const { continue: continuePath, handoff_jwk: handoffJwkB64, handoff_proof: handoffProofB64, link, link_grant: linkGrantId } = c.req.valid('query');

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

    // RFC-0014 phase 3 (AC-1/AC-2) — LINK mode. Everything the link is
    // aimed at comes from the authenticated session plus the server-side
    // grant; nothing here is taken from a query parameter a link URL could
    // carry. The per-path middleware installed in `registerFederatedAuthRoutes`
    // has already rejected a missing/non-web credential by the time we get
    // here, so `c.get('user')` is a real web-session user whenever
    // `link === '1'`.
    let linkToUserId: string | undefined;
    let linkAuthVersion: number | undefined;
    if (link === '1') {
      const linkUser = c.get('user');
      if (!linkUser) return c.json(AUTH_REQUIRED_BODY, 401);
      if (!linkGrantId) return c.json(invalidRequestBody('link_grant is required when link=1'), 400);

      const grant = await linkGrantStore.consume(linkGrantId);
      // One `invalidRequestBody` for every failure below: unknown, expired,
      // already-used, wrong provider, wrong user, stale authVersion and
      // wrong sender key are all just "this grant does not authorize this
      // start", and distinguishing them would tell an attacker which half
      // of a stolen link URL still works.
      if (!grant) return c.json(invalidRequestBody('link grant is invalid or expired'), 400);
      if (grant.provider !== name) return c.json(invalidRequestBody('link grant is invalid or expired'), 400);
      if (grant.userId !== linkUser._id.toString()) return c.json(invalidRequestBody('link grant is invalid or expired'), 400);
      if ((linkUser.authVersion ?? 0) !== grant.authVersion) return c.json(invalidRequestBody('link grant is invalid or expired'), 400);
      // AC-2: the grant is pinned to the sender key of the browser that
      // MINTED it. A stolen link URL opened in a different browser presents
      // that browser's own key, so the thumbprints differ here and the flow
      // stops before any state cookie or IdP redirect exists.
      if (!timingSafeEqualStrings(grant.handoffChallenge, handoffJkt)) {
        return c.json(invalidRequestBody('link grant is invalid or expired'), 400);
      }

      linkToUserId = grant.userId;
      linkAuthVersion = grant.authVersion;
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const oidcNonce = driver.kind === 'oidc' ? crypto.randomBytes(32).toString('base64url') : undefined;
    const usePkce = driver.kind === 'oidc' || driver.pkce === true;
    const codeVerifier = usePkce ? generatePkceCodeVerifier() : undefined;

    const cookieValue = stateUtil.issue({ state, provider: name, continuePath, codeVerifier, oidcNonce, handoffJkt, linkToUserId, linkAuthVersion });
    setCookie(c, stateUtil.cookieName, cookieValue, stateUtil.cookieOptions);

    const redirectUri = buildProviderCallbackUrl(urls.apiUrl, name);

    if (driver.kind === 'oidc') {
      let configuration: Awaited<ReturnType<typeof driver.getConfiguration>>;
      try {
        // `getConfiguration()` performs network discovery on a cache miss
        // (RFC-0014 phase 0 §"設計の主な判断") and can reject — it MUST stay
        // inside this try/catch (not awaited unguarded) so a discovery
        // failure maps to the same safe "provider unusable" response as the
        // synchronous null-config check below, instead of escaping to
        // Hono's global 500 handler (AC-3).
        configuration = await driver.getConfiguration();
      } catch (err) {
        debug('oidc getConfiguration() failed at start for provider=%s: %s', name, (err as Error).message);
        return c.json(PROVIDER_NOT_FOUND_BODY, 404);
      }
      if (!configuration) return c.json(PROVIDER_NOT_FOUND_BODY, 404);
      const { buildAuthorizationUrl } = await loadOidcClient();
      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        scope: driver.scopes.join(' '),
        state,
        nonce: oidcNonce as string,
        code_challenge: computePkceCodeChallengeS256(codeVerifier as string),
        code_challenge_method: 'S256',
      });
      const authorizeUrl = buildAuthorizationUrl(configuration, params);
      return c.redirect(authorizeUrl.toString(), 302);
    }

    const clientConfig = driver.getClientConfig();
    if (!clientConfig) return c.json(PROVIDER_NOT_FOUND_BODY, 404);
    const authorizeUrl = new URL(driver.authorizeUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientConfig.clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    if (driver.scopes.length > 0) authorizeUrl.searchParams.set('scope', driver.scopes.join(' '));
    authorizeUrl.searchParams.set('state', state);
    if (usePkce) {
      authorizeUrl.searchParams.set('code_challenge', computePkceCodeChallengeS256(codeVerifier as string));
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    }
    return c.redirect(authorizeUrl.toString(), 302);
  };
}

/**
 * `GET /auth/providers/{name}/callback` — the IdP redirect target. Verifies
 * the state cookie, completes the OAuth2/OIDC protocol exchange, delegates
 * to `FederatedProfileTerminal`, and — only once the terminal resolves an
 * active user — issues a sender-constrained handoff code and redirects to
 * the trusted web `/login/complete`.
 */
export function completeFederatedCallback(deps: FederatedAuthRouteDeps): RouteHandler<typeof callbackFederatedProviderRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, terminal, handoffStore, linkingTerminal, getEnabledDriver } = deps;
  return async (c) => {
    const { name } = c.req.valid('param');

    // Read + immediately clear the state cookie, BEFORE any other check —
    // it must be consumed exactly once regardless of outcome (AC-2).
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

    const { code, state: returnedState, error } = c.req.valid('query');

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

    let profile: AuthProfile;
    if (driver.kind === 'oidc') {
      try {
        // `getConfiguration()` performs network discovery on a cache miss
        // (RFC-0014 phase 0 §"設計の主な判断") and can reject — it MUST stay
        // inside this try/catch (not awaited ahead of it) so a discovery
        // failure maps to the safe redirect below instead of escaping to
        // Hono's global 500 handler (AC-3).
        const configuration = await driver.getConfiguration();
        if (!configuration) return c.redirect(buildLoginErrorUrl(urls.webUrl, 'invalid_state'), 302);

        // openid-client derives the token endpoint's `redirect_uri` by
        // stripping the query string off this URL — it MUST therefore be
        // the exact trusted callback URL (no query of its own), with the
        // real response query attached, not the internal (prefix-stripped)
        // request URL Hono sees.
        const currentUrl = new URL(buildProviderCallbackUrl(urls.apiUrl, name));
        currentUrl.search = new URL(c.req.url).search;

        const { authorizationCodeGrant } = await loadOidcClient();
        const tokens = await authorizationCodeGrant(configuration, currentUrl, {
          expectedState: state.state,
          expectedNonce: state.oidcNonce,
          pkceCodeVerifier: state.codeVerifier,
        });
        const claims = tokens.claims();
        if (!claims) return c.redirect(buildLoginErrorUrl(urls.webUrl, 'oidc_verification_failed'), 302);

        if (driver.authorize) {
          const authResult = await driver.authorize(claims as Record<string, unknown>);
          if (!authResult.ok) return c.redirect(buildLoginErrorUrl(urls.webUrl, 'profile_rejected'), 302);
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
        profile = {
          providerUserId: mapped.providerUserId ?? String(claims.sub),
          email: mapped.email ?? (emailVerified && typeof claims.email === 'string' ? claims.email : undefined),
          name: mapped.name ?? (typeof claims.name === 'string' ? claims.name : undefined),
          imageUrl: mapped.imageUrl ?? (typeof claims.picture === 'string' ? claims.picture : undefined),
          extra: mapped.extra,
        };
      } catch (err) {
        debug('oidc callback verification failed for provider=%s: %s', name, (err as Error).message);
        return c.redirect(buildLoginErrorUrl(urls.webUrl, 'oidc_verification_failed'), 302);
      }
    } else {
      const clientConfig = driver.getClientConfig();
      if (!clientConfig) return c.redirect(buildLoginErrorUrl(urls.webUrl, 'invalid_state'), 302);

      let tokens: OAuthTokens;
      try {
        tokens = await exchangeOAuth2Code(driver, clientConfig, {
          code,
          redirectUri: buildProviderCallbackUrl(urls.apiUrl, name),
          codeVerifier: state.codeVerifier,
        });
      } catch (err) {
        debug('oauth2 token exchange failed for provider=%s: %s', name, (err as Error).message);
        return c.redirect(buildLoginErrorUrl(urls.webUrl, 'exchange_failed'), 302);
      }

      // `fetchProfile` is plugin-authored code — a REJECTED Promise (not
      // just an `{ ok: false }` result) must not escape to Hono's global
      // 500 handler either (AC-3).
      let result: AuthVerifyResult;
      try {
        result = await driver.fetchProfile(tokens);
      } catch (err) {
        debug('oauth2 fetchProfile threw for provider=%s: %s', name, (err as Error).message);
        return c.redirect(buildLoginErrorUrl(urls.webUrl, 'profile_rejected'), 302);
      }
      if (!result.ok) {
        debug('oauth2 fetchProfile rejected provider=%s: %s', name, result.reason);
        return c.redirect(buildLoginErrorUrl(urls.webUrl, 'profile_rejected'), 302);
      }
      profile = result.profile;
    }

    // RFC-0014 phase 3 (AC-3) — LINK branch. A signed state carrying
    // `linkToUserId` means this flow was started from an authenticated
    // settings action, so phase 2's provisioning is skipped ENTIRELY: no
    // registration-mode gate, no whitelist, no email lookup, no User
    // creation. The target is the value inside the signed cookie and
    // nothing else.
    if (state.linkToUserId) {
      const User = crowi.model('User');
      const linkUser = await User.findById(state.linkToUserId);
      // Re-check the session is still the one that started this, now that
      // the IdP round trip has elapsed: a password reset or forced
      // sign-out in between bumps `authVersion`, and such a flow must link
      // nothing (spec flow step 4).
      if (!linkUser || (linkUser.authVersion ?? 0) !== (state.linkAuthVersion ?? 0)) {
        return c.redirect(buildLinkSettingsUrl(urls.webUrl, name, 'link_failed'), 302);
      }

      const outcome = await linkingTerminal.link({ userId: state.linkToUserId, provider: name, providerUserId: profile.providerUserId });
      // `already_linked_here` is a success: re-linking what you already
      // linked is the state you asked for (see the terminal's doc comment).
      // Both refusals collapse to the ONE stable conflict code the spec's
      // error semantics define (`federated_identity_in_use`) — phase 4 owns
      // the wording, and a second code would say more about other accounts
      // than this redirect should.
      const result =
        outcome.kind === 'owned_by_other_user' || outcome.kind === 'provider_slot_taken'
          ? 'federated_identity_in_use'
          : outcome.kind === 'failed'
            ? 'link_failed'
            : 'linked';
      return c.redirect(buildLinkSettingsUrl(urls.webUrl, name, result), 302);
    }

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

export const registerFederatedAuthRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(
  app: E,
  crowi: Crowi,
  options: RegisterFederatedAuthRoutesOptions = {},
) => {
  const terminal = options.terminal ?? createUnavailableFederatedProfileTerminal();
  const stateUtil = createFederatedAuthStateUtil(crowi);
  const handoffStore =
    options.handoffStore ??
    createFederatedHandoffStore({
      redisClient: crowi.redis,
      keyspace: resolveRedisKeyspaceIfEnabled(crowi),
    });
  const linkGrantStore =
    options.linkGrantStore ??
    createLinkGrantStore({
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

  const deps: FederatedAuthRouteDeps = { crowi, stateUtil, handoffStore, terminal, linkGrantStore, linkingTerminal, getEnabledDriver };

  // RFC-0014 phase 3 (AC-1) — the link surfaces require an active WEB
  // session. `/start` stays public for ordinary sign-in and only becomes
  // authenticated when `link=1`, so the JWT middleware is applied through a
  // conditional wrapper rather than to the whole path: a public sign-in
  // start must not start demanding a token.
  const jwtAuth = createJwtAuth(crowi);
  app.use('/auth/providers/:name/start', async (c, next) => {
    if (c.req.query('link') !== '1') return next();
    return jwtAuth(c, next);
  });
  app.use('/auth/providers/:name/link-grants', jwtAuth);
  app.use('/auth/providers/:name/identity', jwtAuth);

  /**
   * Spec design decision 1 / AC-1: a PAT or OAuth access token is a valid
   * credential for the API but NOT for linking — linking is a
   * session-level account change, and a long-lived integration token must
   * not be able to attach a new sign-in method to its owner's account.
   * 403 (not 401): the caller authenticated fine, this credential kind is
   * simply not permitted here.
   */
  const isWebSession = (c: Context<CrowiHonoBindings>): boolean => c.get('authContext')?.kind === 'web';
  const NOT_WEB_SESSION_BODY = invalidRequestBody('this endpoint requires an interactive web session');

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
    .openapi(createAuthProviderLinkGrantRoute, async (c) => {
      const { name } = c.req.valid('param');
      if (!isWebSession(c)) return c.json(NOT_WEB_SESSION_BODY, 403);

      const user = c.get('user');
      if (!user) return c.json(AUTH_REQUIRED_BODY, 401);
      if (!getEnabledDriver(name)) return c.json(PROVIDER_NOT_FOUND_BODY, 404);

      const { handoffChallenge } = c.req.valid('json');

      try {
        // Everything bound here comes from the SERVER's view of the caller
        // (`c.get('user')`, set by the JWT middleware) — the request body
        // contributes only the sender-key thumbprint. That is what makes a
        // stolen link URL useless in another browser (AC-2) without ever
        // letting the body name a target account.
        const linkGrant = await linkGrantStore.issue({
          userId: user._id.toString(),
          provider: name,
          authVersion: user.authVersion ?? 0,
          handoffChallenge,
        });
        return c.json({ linkGrant }, 200);
      } catch (err) {
        debug('link grant issuance failed: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
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
