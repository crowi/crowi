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
 */
import { callbackFederatedProviderRoute, federatedHandoffRoute, listFederatedProvidersRoute, startFederatedProviderRoute } from '@crowi/api-contract';
import type { AuthDriver, AuthProfile, AuthVerifyResult, OAuth2AuthDriver, OAuthClientConfig, OAuthTokens, OidcAuthDriver } from '@crowi/plugin-api';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import crypto from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import Debug from 'debug';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type Crowi from 'src/crowi';
import { createUnavailableFederatedProfileTerminal, type FederatedProfileTerminal } from 'src/auth/federated-profile-terminal';
import { createFederatedHandoffStore, type FederatedHandoffStore } from 'src/service/federated-handoff';
import { createJwtUtil } from 'src/util/jwt';
import {
  buildHandoffCanonicalMessage,
  buildLoginCompleteUrl,
  buildLoginErrorUrl,
  buildProviderCallbackUrl,
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
import { INTERNAL_ERROR_BODY, invalidRequestBody } from './_helpers/errors';
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
  /** Enabled = registered, oauth2/oidc kind, and currently configured (design decision 1). */
  getEnabledDriver: (name: string) => FederatedRouteDriver | null;
}

/**
 * `GET /auth/providers/{name}/start` — validates the sender proof, mints the
 * signed state cookie (+ OIDC nonce / PKCE verifier when applicable), and
 * redirects the browser to the provider's authorize endpoint.
 */
export function buildProviderRedirect(deps: FederatedAuthRouteDeps): RouteHandler<typeof startFederatedProviderRoute, CrowiHonoBindings> {
  const { crowi, stateUtil, getEnabledDriver } = deps;
  return async (c) => {
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

    const state = crypto.randomBytes(32).toString('base64url');
    const oidcNonce = driver.kind === 'oidc' ? crypto.randomBytes(32).toString('base64url') : undefined;
    const usePkce = driver.kind === 'oidc' || driver.pkce === true;
    const codeVerifier = usePkce ? generatePkceCodeVerifier() : undefined;

    const cookieValue = stateUtil.issue({ state, provider: name, continuePath, codeVerifier, oidcNonce, handoffJkt });
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
  const { crowi, stateUtil, terminal, handoffStore, getEnabledDriver } = deps;
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
        profile = {
          providerUserId: mapped.providerUserId ?? String(claims.sub),
          email: mapped.email ?? (typeof claims.email === 'string' ? claims.email : undefined),
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

    const terminalResult = await terminal.resolve({ provider: name, profile });
    if (terminalResult.kind === 'redirect_error') {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, terminalResult.code), 302);
    }

    const User = crowi.model('User');
    const activeUser = terminalResult.user;
    if (activeUser.status !== User.STATUS_ACTIVE) {
      return c.redirect(buildLoginErrorUrl(urls.webUrl, 'account_inactive'), 302);
    }

    const handoffCode = await handoffStore.issue(activeUser._id.toString(), state.handoffJkt);
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
  const handoffStore = createFederatedHandoffStore({
    redisClient: crowi.redis,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  const getEnabledDriver = (name: string): FederatedRouteDriver | null => {
    const driver = crowi.getPlugins().auth.get(name);
    if (!driver || !isFederatedDriver(driver)) return null;
    if (driver.getClientConfig() == null) return null;
    return driver;
  };

  const deps: FederatedAuthRouteDeps = { crowi, stateUtil, handoffStore, terminal, getEnabledDriver };

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

        const tokens = jwtUtil.generateTokens(user);
        return c.json({ ...tokens, user: toAuthUser(user) }, 200);
      } catch (err) {
        debug('handoff failed: %s', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
