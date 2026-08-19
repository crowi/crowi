import crypto from 'node:crypto';
import { type AuthProviderLinkingTerminal, createAuthProviderLinkingTerminal } from 'src/auth/auth-provider-linking';
import { createUnavailableFederatedProfileTerminal, type FederatedProfileTerminal } from 'src/auth/federated-profile-terminal';
import { createHonoApp } from 'src/hono/app';
import { buildProviderRedirect, completeFederatedCallback, registerFederatedAuthRoutes } from 'src/hono/handlers/federated-auth';
import type { UserDocument } from 'src/models/user';
import { createLinkCompletionStore } from 'src/service/link-completion';
import { app, crowi, Fixture, randomUsername } from 'src/test/setup';
import {
  buildHandoffCanonicalMessage,
  buildStartCanonicalMessage,
  computeJwkThumbprint,
  createFederatedAuthStateUtil,
  type FederatedAuthStateUtil,
  FederatedLinkStateCookieTooLargeError,
  MAX_LINK_STATE_COOKIE_VALUE_BYTES,
} from 'src/util/federated-auth-state';
import { createJwtUtil } from 'src/util/jwt';
import { verifyPkceS256 } from 'src/util/pkce';
import request from 'supertest';

/**
 * `openid-client` is ESM-only and mocked at the module level (same pattern
 * `@crowi/plugin-api`'s `registries/auth.test.ts` uses for `discovery`) —
 * `federated-auth.ts` only ever reaches it via a deferred `import(
 * 'openid-client')`, so this mock is picked up regardless of which module
 * triggers the dynamic import.
 */
jest.mock('openid-client', () => ({
  discovery: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  authorizationCodeGrant: jest.fn(),
}));
const oidcMock = jest.requireMock('openid-client') as {
  discovery: jest.Mock;
  buildAuthorizationUrl: jest.Mock;
  authorizationCodeGrant: jest.Mock;
};

const TEST_URLS = { apiUrl: 'https://api.test.example', webUrl: 'https://web.test.example' };

/** Generates a P-256 key pair and returns a signer over it — the sender-key half of the flow (RFC-0014 phase 1 §"設計の主な判断" 3/4). */
async function createSenderKeyPair() {
  const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = (await crypto.webcrypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const publicJwkB64 = Buffer.from(JSON.stringify(publicJwk)).toString('base64url');
  const sign = async (message: string): Promise<string> => {
    const sigBuf = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message));
    return Buffer.from(sigBuf).toString('base64url');
  };
  return { publicJwk, publicJwkB64, sign };
}

async function buildStartQuery(providerName: string, continuePath: string, keyPair: Awaited<ReturnType<typeof createSenderKeyPair>>): Promise<string> {
  const message = buildStartCanonicalMessage(TEST_URLS.apiUrl, providerName, continuePath, keyPair.publicJwkB64);
  const proof = await keyPair.sign(message);
  return `continue=${encodeURIComponent(continuePath)}&handoff_jwk=${keyPair.publicJwkB64}&handoff_proof=${proof}`;
}

async function buildHandoffProof(code: string, keyPair: Awaited<ReturnType<typeof createSenderKeyPair>>) {
  const message = buildHandoffCanonicalMessage(TEST_URLS.apiUrl, code);
  const signature = await keyPair.sign(message);
  return { publicJwk: keyPair.publicJwk, signature };
}

/** `res.headers.location` typed loosely by supertest — small helper to keep call sites terse. */
function locationOf(res: { headers: Record<string, unknown> }): string {
  return res.headers.location as string;
}

function extractStateCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const stateCookie = arr.find((c) => c.startsWith('crowi.oauthState='));
  if (!stateCookie) throw new Error('state cookie was not set on the response');
  return stateCookie.split(';')[0];
}

/**
 * `GET .../start` against the shared supertest `app`, then extract the
 * signed state cookie and the IdP-echoed `state` query value off the
 * redirect — the common setup every `request(app)`-based callback test
 * below needs before it can hit `/callback`. Not used by the `localApp`
 * (Hono `.request()`) tests, which read headers off a `Response` rather
 * than a supertest `res` and extract state/code differently.
 */
async function startFlow(providerName: string, continuePath = '/dashboard') {
  const keyPair = await createSenderKeyPair();
  const startQuery = await buildStartQuery(providerName, continuePath, keyPair);
  const startRes = await request(app).get(`/api/auth/providers/${providerName}/start?${startQuery}`).redirects(0);
  const cookie = extractStateCookie(startRes);
  const state = new URL(locationOf(startRes)).searchParams.get('state') as string;
  return { keyPair, startRes, cookie, state };
}

/** Swaps in `impl` for `globalThis.fetch` (stubbing the OAuth2 token-exchange call the callback handler makes) and returns the restore function — callers MUST invoke it in a `finally`. Shared by every callback test that needs to control what the token endpoint returns. */
function mockFetch(impl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeOAuth2Driver(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'oauth2' as const,
    buttonLabel: 'Sign in with Test OAuth2',
    authorizeUrl: 'https://idp.example.com/oauth2/authorize',
    tokenUrl: 'https://idp.example.com/oauth2/token',
    scopes: ['read'],
    pkce: true,
    getClientConfig: () => ({ clientId: 'oauth2-client', clientSecret: 'oauth2-secret' }),
    fetchProfile: async () => ({ ok: true as const, profile: { providerUserId: 'oauth2-user-1', email: 'oauth2-user@example.com' } }),
    ...overrides,
  };
}

function makeOidcDriver(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'oidc' as const,
    buttonLabel: 'Sign in with Test OIDC',
    discoveryUrl: 'https://idp.example.com/oidc/.well-known/openid-configuration',
    scopes: ['openid', 'email', 'profile'],
    pkce: true as const,
    getClientConfig: () => ({ clientId: 'oidc-client', clientSecret: 'oidc-secret' }),
    getConfiguration: async () => ({ __fakeConfiguration: true }) as never,
    ...overrides,
  };
}

async function seedActiveUser(email: string, username: string): Promise<UserDocument> {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email }, { username }] });
  return new Promise((resolve, reject) => {
    User.createUserByEmailAndPassword('Federated Test User', username, email, 'Password!1', 'en', async (err: Error | null, user: UserDocument) => {
      if (err) return reject(err);
      user.status = User.STATUS_ACTIVE;
      await user.save();
      resolve(user);
    });
  });
}

/**
 * The `UserIdentity` row a resolved sign-in implies. The stub terminals
 * below return `{kind:'resolved', user}` directly, but in production a
 * terminal only ever resolves BECAUSE it found this row — and RFC-0014
 * phase 3's handoff identity fence re-checks it immediately before minting
 * tokens. Without seeding it, these tests would be asserting against a
 * state production can never reach (a resolved sign-in with no identity).
 */
async function seedResolvedIdentity(user: UserDocument, provider: string, providerUserId: string): Promise<void> {
  const UserIdentity = crowi.model('UserIdentity');
  // `{provider, providerUserId}` is unique — clear any row a previous case
  // in this file left behind for the same provider account.
  await UserIdentity.deleteMany({ provider, providerUserId });
  await UserIdentity.create({ userId: user._id, provider, providerUserId });
}

/** Builds a standalone federated-auth app wired to a caller-supplied terminal (a test seam the shared `app` — always the Phase-1 default terminal — cannot exercise). */
function buildLocalApp(terminal: FederatedProfileTerminal) {
  return registerFederatedAuthRoutes(createHonoApp(), crowi, { terminal });
}

describe('federated auth (RFC-0014 phase 1)', () => {
  let savedUrls: { apiUrl: string; webUrl: string } | null;

  beforeAll(() => {
    savedUrls = crowi.federatedAuthPublicUrls;
    crowi.federatedAuthPublicUrls = TEST_URLS;
    crowi.getPlugins().auth.register('fed-oauth2', makeOAuth2Driver(), 'test-plugin');
    crowi.getPlugins().auth.register('fed-oauth2-unconfigured', makeOAuth2Driver({ getClientConfig: () => null }), 'test-plugin');
    crowi.getPlugins().auth.register('fed-credential', { kind: 'credential', fields: [], verify: async () => ({ ok: false, reason: 'n/a' }) }, 'test-plugin');
    crowi.getPlugins().auth.register('fed-oidc', makeOidcDriver(), 'test-plugin');
  });

  afterAll(() => {
    crowi.federatedAuthPublicUrls = savedUrls;
  });

  beforeEach(() => {
    oidcMock.discovery.mockReset();
    // Echo the real params (including `state`) back into the fake authorize
    // URL, so tests can read the actual server-generated `state` off it —
    // a static canned URL would make every OIDC test's `state` come back
    // as `null`.
    oidcMock.buildAuthorizationUrl
      .mockReset()
      .mockImplementation((_config: unknown, params: URLSearchParams) => new URL(`https://idp.example.com/oidc/authorize?${params.toString()}`));
    oidcMock.authorizationCodeGrant.mockReset();
  });

  describe('GET /api/auth/providers (AC-1)', () => {
    test('lists only enabled oauth2/oidc providers, sorted by name — excludes credential and unconfigured drivers', async () => {
      const res = await request(app).get('/api/auth/providers');
      expect(res.status).toBe(200);
      const names = (res.body.providers as { name: string }[]).map((p) => p.name);
      expect(names).toContain('fed-oauth2');
      expect(names).toContain('fed-oidc');
      expect(names).not.toContain('fed-oauth2-unconfigured');
      expect(names).not.toContain('fed-credential');
      // sorted by name
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    });

    test('returns an empty list when trusted origins are unresolvable', async () => {
      crowi.federatedAuthPublicUrls = null;
      try {
        const res = await request(app).get('/api/auth/providers');
        expect(res.status).toBe(200);
        expect(res.body.providers).toEqual([]);
      } finally {
        crowi.federatedAuthPublicUrls = TEST_URLS;
      }
    });
  });

  describe('GET /api/auth/providers/:name/start (AC-1, AC-2, AC-4)', () => {
    test('404s for an unknown provider', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('no-such-provider', '/dashboard', keyPair);
      const res = await request(app).get(`/api/auth/providers/no-such-provider/start?${query}`).redirects(0);
      expect(res.status).toBe(404);
    });

    test('404s for an unconfigured provider', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oauth2-unconfigured', '/dashboard', keyPair);
      const res = await request(app).get(`/api/auth/providers/fed-oauth2-unconfigured/start?${query}`).redirects(0);
      expect(res.status).toBe(404);
    });

    test('404s for a credential-kind provider', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-credential', '/dashboard', keyPair);
      const res = await request(app).get(`/api/auth/providers/fed-credential/start?${query}`).redirects(0);
      expect(res.status).toBe(404);
    });

    test('400s when the sender proof does not verify', async () => {
      const keyPair = await createSenderKeyPair();
      const res = await request(app)
        .get(
          `/api/auth/providers/fed-oauth2/start?continue=${encodeURIComponent('/dashboard')}&handoff_jwk=${keyPair.publicJwkB64}&handoff_proof=not-a-real-signature`,
        )
        .redirects(0);
      expect(res.status).toBe(400);
    });

    test.each([
      [
        '/' + String.fromCharCode(92) + 'evil.example/path',
        'single backslash — WHATWG URL parsers treat \\ as a path separator, so this is equivalent to //evil.example/path',
      ],
      ['/' + String.fromCharCode(92, 92) + 'evil.example', 'double backslash'],
      [
        '/' + String.fromCharCode(9) + '/evil.example',
        'leading tab (C0 control char) — URL parsers strip it before resolving, collapsing this to //evil.example',
      ],
      ['/' + String.fromCharCode(10) + '/evil.example', 'leading newline (C0 control char)'],
      ['//evil.example/path', 'protocol-relative (bare double slash)'],
    ])('400s for a continue value the query-schema regex must reject as an off-origin redirect vector: %s (AC-4)', async (continuePath) => {
      // Query validation (zod-openapi's defaultHook, VALIDATION_ERROR code)
      // runs BEFORE the handler, so an invalid `continue` must 400 there —
      // asserting on the error code (not just the status) distinguishes
      // this from the handler's OWN 400s (INVALID_REQUEST, e.g. a
      // malformed handoff_jwk/proof), which would otherwise mask a
      // still-vulnerable regex behind an unrelated 400.
      const res = await request(app)
        .get(`/api/auth/providers/fed-oauth2/start?continue=${encodeURIComponent(continuePath)}&handoff_jwk=AAAA&handoff_proof=AAAA`)
        .redirects(0);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('accepts an ordinary local path as continue (AC-4 regression guard against over-blocking)', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oauth2', '/normal/page', keyPair);
      const res = await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}`).redirects(0);
      expect(res.status).toBe(302);
    });

    test('redirects to the provider authorize endpoint, setting a signed HttpOnly state cookie, and the redirect_uri uses the trusted API origin', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
      const res = await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}`).redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('idp.example.com');
      const location = new URL(res.headers.location as string);
      expect(location.searchParams.get('redirect_uri')).toBe('https://api.test.example/api/auth/providers/fed-oauth2/callback');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');

      const cookie = extractStateCookie(res);
      expect(cookie).toMatch(/^crowi\.oauthState=/);
      const setCookieHeader = (res.headers['set-cookie'] as string[]).find((c) => c.startsWith('crowi.oauthState='));
      expect(setCookieHeader).toContain('HttpOnly');
      expect(setCookieHeader).toContain('Path=/api/auth/providers');
      expect(setCookieHeader).toContain('SameSite=Lax');
    });

    test('OIDC getConfiguration() REJECTED Promise on the FIRST call (discovery failure at /start itself) is caught, never a 500/unhandled rejection (AC-3)', async () => {
      // Distinct from the callback-side regression test below, which models
      // discovery succeeding once (consumed by /start) and rejecting on a
      // LATER re-fetch. This pins the /start call site's OWN await —
      // `buildProviderRedirect` previously awaited `driver.getConfiguration()`
      // outside any try/catch, so a discovery failure here escaped straight
      // to Hono's global error handler instead of the same safe "provider
      // unusable" response the synchronous null-config check two lines
      // below it already returns.
      crowi.getPlugins().auth.register(
        'fed-oidc-start-discovery-fail',
        makeOidcDriver({
          getConfiguration: async () => {
            throw new Error('discovery endpoint unreachable');
          },
        }),
        'test-plugin',
      );

      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oidc-start-discovery-fail', '/dashboard', keyPair);
      const res = await request(app).get(`/api/auth/providers/fed-oidc-start-discovery-fail/start?${query}`).redirects(0);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/auth/providers/:name/start — nonce/PKCE are server-generated, not caller-supplied (AC-2)', () => {
    test('the OIDC nonce differs across two independent /start calls', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oidc', '/dashboard', keyPair);

      const first = await request(app).get(`/api/auth/providers/fed-oidc/start?${query}`).redirects(0);
      const second = await request(app).get(`/api/auth/providers/fed-oidc/start?${query}`).redirects(0);

      const nonce1 = new URL(locationOf(first)).searchParams.get('nonce');
      const nonce2 = new URL(locationOf(second)).searchParams.get('nonce');
      expect(nonce1).toBeTruthy();
      expect(nonce2).toBeTruthy();
      expect(nonce1).not.toBe(nonce2);
    });

    test('the OIDC authorize code_challenge corresponds (RFC 7636 S256) to the code_verifier later supplied at token exchange', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oidc', '/dashboard', keyPair);
      const startRes = await request(app).get(`/api/auth/providers/fed-oidc/start?${query}`).redirects(0);
      const location = new URL(locationOf(startRes));
      const codeChallenge = location.searchParams.get('code_challenge') as string;
      const state = location.searchParams.get('state') as string;
      const cookie = extractStateCookie(startRes);

      let capturedVerifier: string | undefined;
      oidcMock.authorizationCodeGrant.mockImplementationOnce(async (_config: unknown, _url: URL, options: { pkceCodeVerifier?: string }) => {
        capturedVerifier = options.pkceCodeVerifier;
        return { claims: () => ({ sub: 'pkce-check-user', email: 'pkce-check@example.com' }) };
      });

      const res = await request(app).get(`/api/auth/providers/fed-oidc/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);

      expect(res.status).toBe(302);
      expect(capturedVerifier).toBeTruthy();
      expect(verifyPkceS256(capturedVerifier as string, codeChallenge)).toBe(true);
    });

    test('the OAuth2 authorize code_challenge corresponds (RFC 7636 S256) to the code_verifier later sent in the token-exchange body', async () => {
      const keyPair = await createSenderKeyPair();
      const query = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
      const startRes = await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}`).redirects(0);
      const location = new URL(locationOf(startRes));
      const codeChallenge = location.searchParams.get('code_challenge') as string;
      const state = location.searchParams.get('state') as string;
      const cookie = extractStateCookie(startRes);

      let capturedVerifier: string | null = null;
      const restoreFetch = mockFetch(
        jest.fn(async (_url: unknown, init?: { body?: string }) => {
          capturedVerifier = new URLSearchParams(init?.body).get('code_verifier');
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }) as unknown as typeof fetch,
      );

      let res: request.Response;
      try {
        res = await request(app).get(`/api/auth/providers/fed-oauth2/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
      } finally {
        restoreFetch();
      }

      expect(res.status).toBe(302);
      expect(capturedVerifier).toBeTruthy();
      expect(verifyPkceS256(capturedVerifier as string, codeChallenge)).toBe(true);
    });
  });

  describe('GET /api/auth/providers/:name/callback — 404 before state/redirect handling, cookie still cleared (AC-1, AC-2)', () => {
    test.each([
      ['an unknown provider', 'no-such-provider'],
      ['an unconfigured provider', 'fed-oauth2-unconfigured'],
      ['a credential-kind provider', 'fed-credential'],
    ])('404s for %s, while still clearing the state cookie', async (_label, providerName) => {
      const res = await request(app).get(`/api/auth/providers/${providerName}/callback?code=abc&state=xyz`).redirects(0);
      expect(res.status).toBe(404);
      const clear = (res.headers['set-cookie'] as string[] | undefined)?.find((c) => c.startsWith('crowi.oauthState='));
      expect(clear).toContain('Max-Age=0');
    });
  });

  describe('GET /api/auth/providers/:name/callback (AC-2, AC-3, AC-4)', () => {
    test('clears the state cookie on failure paths (missing cookie, wrong state)', async () => {
      const { cookie } = await startFlow('fed-oauth2');

      // Failure path: no cookie at all.
      const failRes = await request(app).get('/api/auth/providers/fed-oauth2/callback?code=abc&state=xyz').redirects(0);
      const failClear = (failRes.headers['set-cookie'] as string[]).find((c) => c.startsWith('crowi.oauthState='));
      expect(failClear).toContain('Max-Age=0');

      // Wrong state: same provider (so the driver-enablement check passes), invalid state comparison.
      const okRes = await request(app).get('/api/auth/providers/fed-oauth2/callback?code=abc&state=wrong-state').set('Cookie', cookie).redirects(0);
      const okClear = (okRes.headers['set-cookie'] as string[]).find((c) => c.startsWith('crowi.oauthState='));
      expect(okClear).toContain('Max-Age=0');
    });

    test('clears the state cookie on a GENUINELY successful callback (terminal resolves, redirects to login/complete)', async () => {
      const user = await seedActiveUser('fed-cookie-clear-success@example.com', 'fed-cookie-clear-success');
      const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user }) });

      const keyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=abc&state=${state}`, { headers: { cookie } });
      } finally {
        restoreFetch();
      }

      expect(callbackRes.status).toBe(302);
      const completeUrl = new URL(callbackRes.headers.get('location') as string);
      expect(completeUrl.pathname).toBe('/login/complete');
      // AC-4: the `continue` path signed into /start's state cookie MUST be
      // re-echoed on the successful redirect (RFC-0014 §5.3) — the web app
      // has no other trusted channel to recover it after the IdP round trip.
      expect(completeUrl.searchParams.get('continue')).toBe('/dashboard');
      const clearHeader = callbackRes.headers.get('set-cookie');
      expect(clearHeader).toContain('crowi.oauthState=');
      expect(clearHeader).toContain('Max-Age=0');
    });

    test('redirects to a safe login error (never 500) when the state cookie is missing/invalid', async () => {
      const res = await request(app).get('/api/auth/providers/fed-oauth2/callback?code=abc&state=xyz').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=invalid_state');
    });

    test('redirects to a safe login error when the IdP itself reports an error', async () => {
      const { cookie, state } = await startFlow('fed-oauth2');

      const res = await request(app).get(`/api/auth/providers/fed-oauth2/callback?error=access_denied&state=${state}`).set('Cookie', cookie).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=idp_error');
    });

    test('OAuth2 fetchProfile rejection redirects to a safe login error, never 500 (AC-3)', async () => {
      const rejecting = makeOAuth2Driver({ fetchProfile: async () => ({ ok: false as const, reason: 'org membership required' }) });
      crowi.getPlugins().auth.register('fed-oauth2-reject', rejecting, 'test-plugin');
      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      try {
        const { cookie, state } = await startFlow('fed-oauth2-reject');

        const res = await request(app).get(`/api/auth/providers/fed-oauth2-reject/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('https://web.test.example/login?error=profile_rejected');
      } finally {
        restoreFetch();
      }
    });

    test('OAuth2 fetchProfile REJECTED Promise (thrown error, not { ok: false }) redirects to a safe login error, never 500 (AC-3)', async () => {
      // Distinct from the "rejection redirects" test above, which only
      // exercises a driver returning a resolved `{ ok: false }` result.
      // Plugin-authored `fetchProfile` can also throw (a network error, a
      // bug) — that Promise REJECTION must be caught too (previously
      // regressed once; see the handler's `try/catch` around the call).
      const throwing = makeOAuth2Driver({
        fetchProfile: async () => {
          throw new Error('unexpected plugin failure');
        },
      });
      crowi.getPlugins().auth.register('fed-oauth2-throw', throwing, 'test-plugin');
      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      try {
        const { cookie, state } = await startFlow('fed-oauth2-throw');

        const res = await request(app).get(`/api/auth/providers/fed-oauth2-throw/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('https://web.test.example/login?error=profile_rejected');
      } finally {
        restoreFetch();
      }
    });

    test('OAuth2 token-exchange failure redirects to a safe login error, never 500 (AC-3)', async () => {
      const restoreFetch = mockFetch(jest.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
      try {
        const { cookie, state } = await startFlow('fed-oauth2');

        const res = await request(app).get(`/api/auth/providers/fed-oauth2/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('https://web.test.example/login?error=exchange_failed');
      } finally {
        restoreFetch();
      }
    });

    test('OIDC id_token/nonce/iss/aud/JWKS validation failure redirects to a safe login error, never 500 (AC-3)', async () => {
      oidcMock.authorizationCodeGrant.mockRejectedValueOnce(new Error('nonce mismatch'));
      const { cookie, state } = await startFlow('fed-oidc');

      const res = await request(app).get(`/api/auth/providers/fed-oidc/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=oidc_verification_failed');
    });

    test('OIDC getConfiguration() REJECTED Promise (discovery failure) redirects to a safe login error, never 500 (AC-3)', async () => {
      // Distinct from the id_token/nonce/iss/aud test above, which rejects
      // `authorizationCodeGrant`. `getConfiguration()` itself performs
      // network discovery on a cache miss and can reject independently — a
      // prior version of this handler awaited it OUTSIDE the callback's
      // try/catch, so this pins the regression directly. The driver
      // succeeds on its FIRST call (consumed by /start, which needs a
      // resolved `Configuration` to build the authorize URL) and rejects on
      // every call after — modelling discovery succeeding once and then
      // failing on a later re-fetch (cache expiry / transient network
      // blip), which is the realistic shape of this failure at callback
      // time.
      let callCount = 0;
      crowi.getPlugins().auth.register(
        'fed-oidc-discovery-fail',
        makeOidcDriver({
          getConfiguration: async () => {
            callCount += 1;
            if (callCount > 1) throw new Error('discovery endpoint unreachable');
            return { __fakeConfiguration: true } as never;
          },
        }),
        'test-plugin',
      );

      const { startRes, cookie, state } = await startFlow('fed-oidc-discovery-fail');
      expect(startRes.status).toBe(302);

      const res = await request(app).get(`/api/auth/providers/fed-oidc-discovery-fail/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=oidc_verification_failed');
    });

    test('OIDC authorize() policy rejection redirects to a safe login error (AC-3)', async () => {
      crowi
        .getPlugins()
        .auth.register(
          'fed-oidc-authorize-reject',
          makeOidcDriver({ authorize: async () => ({ ok: false as const, reason: 'domain not allowed' }) }),
          'test-plugin',
        );
      oidcMock.authorizationCodeGrant.mockResolvedValueOnce({ claims: () => ({ sub: 'user-1', email: 'user@example.com' }) });

      const { cookie, state } = await startFlow('fed-oidc-authorize-reject');

      const res = await request(app).get(`/api/auth/providers/fed-oidc-authorize-reject/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=profile_rejected');
    });

    test('the Phase-1 default (always-decline) terminal declines with registration_unavailable and performs no User/UserIdentity write (AC-5)', async () => {
      // The SHARED `app` (built by the real `buildHonoApp`) wires Phase 2's
      // real registration terminal by default — this test exercises the
      // Phase-1 default terminal specifically (still exported, still the
      // fallback `registerFederatedAuthRoutes` uses when no `terminal`
      // option is passed), so it must build its own local app rather than
      // rely on the shared one's current wiring.
      oidcMock.authorizationCodeGrant.mockResolvedValueOnce({ claims: () => ({ sub: 'brand-new-user', email: 'brand-new@example.com' }) });
      const localApp = buildLocalApp(createUnavailableFederatedProfileTerminal());

      const keyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oidc', '/dashboard', keyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oidc/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const User = crowi.model('User');
      const before = await User.countDocuments({ email: 'brand-new@example.com' });
      expect(before).toBe(0);

      const callbackRes = await localApp.request(`/auth/providers/fed-oidc/callback?code=abc&state=${state}`, { headers: { cookie } });
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('https://web.test.example/login?error=registration_unavailable');

      const after = await User.countDocuments({ email: 'brand-new@example.com' });
      expect(after).toBe(0);
    });
  });

  describe('resolved terminal -> handoff -> POST /api/auth/handoff (AC-5, AC-6, AC-7)', () => {
    test('a terminal resolving an active user completes handoff with the same token shape as /auth/login', async () => {
      const user = await seedActiveUser('fed-handoff-resolved@example.com', 'fed-handoff-resolved');
      await seedResolvedIdentity(user, 'fed-oauth2', 'oauth2-user-1');
      const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user }) });

      const keyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=abc&state=${state}`, { headers: { cookie } });
      } finally {
        restoreFetch();
      }
      expect(callbackRes.status).toBe(302);
      const completeUrl = new URL(callbackRes.headers.get('location') as string);
      expect(completeUrl.origin + completeUrl.pathname).toBe('https://web.test.example/login/complete');
      expect(completeUrl.searchParams.get('continue')).toBe('/dashboard');
      const code = completeUrl.searchParams.get('code') as string;
      expect(code).toBeTruthy();

      const proof = await buildHandoffProof(code, keyPair);
      const handoffRes = await localApp.request('/auth/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, proof }),
      });
      expect(handoffRes.status).toBe(200);
      const body = (await handoffRes.json()) as { accessToken: string; refreshToken: string; expiresIn: number; user: { email: string } };
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.expiresIn).toEqual(expect.any(Number));
      expect(body.user.email).toBe('fed-handoff-resolved@example.com');

      // A second handoff with the SAME valid proof must fail — consumed once.
      const secondRes = await localApp.request('/auth/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, proof }),
      });
      expect(secondRes.status).toBe(409);
    });

    test('AC-6 — an attacker who steals the start URL and completes the IdP flow with their OWN account cannot redeem the handoff without the victim sender key', async () => {
      const attackerUser = await seedActiveUser('fed-ac6-attacker@example.com', 'fed-ac6-attacker');
      await seedResolvedIdentity(attackerUser, 'fed-oauth2', 'oauth2-user-1');
      const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user: attackerUser }) });

      // Victim generates a sender key pair and would have navigated this
      // exact start URL — the attacker instead opens the (leaked) URL.
      const victimKeyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', victimKeyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=attacker-idp-code&state=${state}`, { headers: { cookie } });
      } finally {
        restoreFetch();
      }
      const code = new URL(callbackRes.headers.get('location') as string).searchParams.get('code') as string;
      expect(code).toBeTruthy();

      // Attacker does NOT have the victim's private key — they can only
      // forge a proof with their OWN fresh key pair.
      const attackerKeyPair = await createSenderKeyPair();
      const attackerProof = await buildHandoffProof(code, attackerKeyPair);
      const attackerRes = await localApp.request('/auth/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, proof: attackerProof }),
      });
      expect(attackerRes.status).toBe(401);

      // The record must still be intact for the legitimate victim holder —
      // proven by the correct (victim) proof succeeding afterward.
      const victimProof = await buildHandoffProof(code, victimKeyPair);
      const victimRes = await localApp.request('/auth/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, proof: victimProof }),
      });
      expect(victimRes.status).toBe(200);
    });

    test('AC-7 — a concurrent attacker (invalid proof) and legitimate holder (valid proof) race: only the legitimate holder succeeds', async () => {
      const user = await seedActiveUser('fed-ac7-holder@example.com', 'fed-ac7-holder');
      await seedResolvedIdentity(user, 'fed-oauth2', 'oauth2-user-1');
      const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user }) });

      const holderKeyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', holderKeyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=abc&state=${state}`, { headers: { cookie } });
      } finally {
        restoreFetch();
      }
      const code = new URL(callbackRes.headers.get('location') as string).searchParams.get('code') as string;

      const attackerKeyPair = await createSenderKeyPair();
      const [attackerProof, holderProof] = await Promise.all([buildHandoffProof(code, attackerKeyPair), buildHandoffProof(code, holderKeyPair)]);

      const [attackerRes, holderRes] = await Promise.all([
        localApp.request('/auth/handoff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, proof: attackerProof }),
        }),
        localApp.request('/auth/handoff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, proof: holderProof }),
        }),
      ]);
      expect(attackerRes.status).toBe(401);
      expect(holderRes.status).toBe(200);
    });

    test('AC-7 — a valid proof sent twice concurrently succeeds at most once (409 for the loser)', async () => {
      const user = await seedActiveUser('fed-ac7-double@example.com', 'fed-ac7-double');
      await seedResolvedIdentity(user, 'fed-oauth2', 'oauth2-user-1');
      const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user }) });

      const keyPair = await createSenderKeyPair();
      const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
      const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
      const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
      const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

      const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=abc&state=${state}`, { headers: { cookie } });
      } finally {
        restoreFetch();
      }
      const code = new URL(callbackRes.headers.get('location') as string).searchParams.get('code') as string;
      const proof = await buildHandoffProof(code, keyPair);

      const [first, second] = await Promise.all([
        localApp.request('/auth/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, proof }) }),
        localApp.request('/auth/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, proof }) }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
    });
  });

  describe('POST /api/auth/handoff — invalid/expired/proof-mismatch (401), never leaks whether a code exists', () => {
    test('401s for a code that was never issued', async () => {
      const keyPair = await createSenderKeyPair();
      const proof = await buildHandoffProof('never-issued-code', keyPair);
      const res = await request(app).post('/api/auth/handoff').send({ code: 'never-issued-code', proof });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FEDERATED_HANDOFF_INVALID');
    });
  });

  describe('buildProviderRedirect / completeFederatedCallback — standalone exported symbols (RFC-0014 phase 1 implementation map)', () => {
    test('are exported as `FederatedAuthRouteDeps -> RouteHandler` factories, independent of registerFederatedAuthRoutes', () => {
      // `registerFederatedAuthRoutes`'s own `/start` and `/callback` wiring
      // (exercised by every other test in this file) calls these two
      // factories directly (`buildProviderRedirect(deps)` /
      // `completeFederatedCallback(deps)`) rather than defining the
      // request-handling logic as private inline closures — pinning their
      // export + factory shape here means a future revert back to inline
      // closures fails at compile time (the import above would no longer
      // resolve) as well as here.
      const noopDeps = {
        crowi,
        stateUtil: {
          cookieName: 'crowi.oauthState',
          cookieOptions: { httpOnly: true as const, sameSite: 'Lax' as const, secure: false, path: '/api/auth/providers', maxAge: 300 },
          linkCookieOptions: { httpOnly: true as const, sameSite: 'Lax' as const, secure: false, path: '/api/auth/providers', maxAge: 300 },
          issue: () => '',
          verify: () => null,
          issueLink: () => '',
          verifyLink: () => null,
          planLinkCookiePrune: () => ({ expireCookieNames: [], projectedCookieHeaderBytes: 0 }),
        },
        handoffStore: { issue: async () => '', find: async () => null, consumeVerified: async () => ({ ok: false as const, reason: 'not_found' as const }) },
        terminal: { resolve: async () => ({ kind: 'redirect_error' as const, code: 'registration_unavailable' as const }) },
        linkingTerminal: { link: async () => ({ kind: 'linked' as const }) },
        getEnabledDriver: () => null,
        getLinkCompletionRuntime: async () => ({
          store: {
            issue: async () => ({ ok: false as const, reason: 'state_expired' as const }),
            find: async () => null,
            consumeVerified: async () => ({ ok: false as const, reason: 'not_found' as const }),
          },
          now: async () => Date.now(),
        }),
      };

      const startHandler = buildProviderRedirect(noopDeps);
      const callbackHandler = completeFederatedCallback(noopDeps);
      // Each factory takes the deps bag and returns a route handler of
      // arity 1 (`(c) => ...`), not e.g. a handler expecting deps as a
      // second Hono middleware argument.
      expect(typeof startHandler).toBe('function');
      expect(startHandler).toHaveLength(1);
      expect(typeof callbackHandler).toBe('function');
      expect(callbackHandler).toHaveLength(1);
    });
  });

  describe('link-start / callback completion / confirmation GET / final POST', () => {
    const webTokenFor = (user: UserDocument) => createJwtUtil(crowi).generateTokens(user).accessToken;

    const seedWebUser = async (email: string, username: string) => {
      const user = await seedActiveUser(email, username);
      return { user, token: webTokenFor(user) };
    };

    const mockTokenFetch = () =>
      mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);

    /** The flow-specific link cookie's full `name=value` pair (`crowi.oauthLinkState.<state>=...`) off a `link-start` response's `Set-Cookie`. */
    function extractLinkCookiePair(res: { headers: Record<string, unknown> }): string {
      const raw = res.headers['set-cookie'] as string[] | string | undefined;
      const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const found = arr.find((c) => c.startsWith('crowi.oauthLinkState.'));
      if (!found) throw new Error('link state cookie was not set on the response');
      return found.split(';')[0];
    }

    /** `provider` + `link_completion` code (success) or `provider` + `link` (failure) off a callback redirect. */
    function extractCallbackOutcome(res: { headers: Record<string, unknown> }): { provider: string | null; code: string | null; linkFailed: string | null } {
      const location = new URL(res.headers.location as string);
      return {
        provider: location.searchParams.get('provider'),
        code: location.searchParams.get('link_completion'),
        linkFailed: location.searchParams.get('link'),
      };
    }

    /** `POST link-start` -> callback -> returns the issued completion code (throws if the flow did not reach a success redirect). */
    async function runFullLinkFlow(providerName: string, token: string): Promise<{ code: string; state: string; cookiePair: string }> {
      const startRes = await request(app).post(`/api/auth/providers/${providerName}/link-start`).set('authorization', `Bearer ${token}`);
      expect(startRes.status).toBe(200);
      const cookiePair = extractLinkCookiePair(startRes);
      const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

      const restoreFetch = mockTokenFetch();
      let callbackRes: request.Response;
      try {
        callbackRes = await request(app)
          .get(`/api/auth/providers/${providerName}/callback?code=idp-code&state=${state}`)
          .set('Cookie', cookiePair)
          .redirects(0);
      } finally {
        restoreFetch();
      }
      expect(callbackRes.status).toBe(302);
      const outcome = extractCallbackOutcome(callbackRes);
      if (!outcome.code) throw new Error(`expected a link_completion code, got redirect ${callbackRes.headers.location}`);
      return { code: outcome.code, state, cookiePair };
    }

    /**
     * Same as `runFullLinkFlow`, but drives a standalone `localApp` (Hono
     * `.request()`) instead of the shared supertest `app` — needed whenever
     * a test injects its own `linkingTerminal`/`linkCompletionRuntimeFactory`
     * into `registerFederatedAuthRoutes` (that override only applies to
     * routes registered on the SAME app instance, and `getLinkCompletionRuntime`
     * is memoized per registered app — see AC-19).
     */
    async function runFullLinkFlowViaLocalApp(
      localApp: ReturnType<typeof registerFederatedAuthRoutes>,
      providerName: string,
      token: string,
    ): Promise<{ code: string }> {
      const startRes = await localApp.request(`/auth/providers/${providerName}/link-start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(startRes.status).toBe(200);
      const cookieHeader = (startRes.headers.get('set-cookie') as string).split(';')[0];
      const startBody = (await startRes.json()) as { authorizationUrl: string };
      const state = new URL(startBody.authorizationUrl).searchParams.get('state') as string;

      const restoreFetch = mockTokenFetch();
      let callbackRes: Response;
      try {
        callbackRes = await localApp.request(`/auth/providers/${providerName}/callback?code=idp-code&state=${state}`, {
          headers: { cookie: cookieHeader },
        });
      } finally {
        restoreFetch();
      }
      const location = new URL(callbackRes.headers.get('location') as string);
      const code = location.searchParams.get('link_completion');
      if (!code) throw new Error(`expected a link_completion code, got redirect ${callbackRes.headers.get('location')}`);
      return { code };
    }

    /** A `LinkCompletionStore` whose every method is a jest mock returning a fixed "not found"/"state expired" shape, for asserting on call counts. */
    function buildSpiedLinkStore() {
      return {
        issue: jest.fn(async () => ({ ok: false as const, reason: 'state_expired' as const })),
        find: jest.fn(async () => null),
        consumeVerified: jest.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
      };
    }

    function buildLocalAppWithSpiedStore() {
      const store = buildSpiedLinkStore();
      const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
        linkCompletionRuntimeFactory: async () => ({ store, now: async () => Date.now() }),
      });
      return { localApp, store };
    }

    // `fed-oauth2`'s fake driver always resolves the SAME fixed
    // `providerUserId: 'oauth2-user-1'` (see `makeOAuth2Driver`) — every
    // test below that runs a full link flow against it shares that one
    // `{provider, providerUserId}` unique-index slot, so a clean slate
    // before each test is what keeps them independent (matches this
    // file's own pre-existing convention of `deleteMany` before a test
    // that expects a fresh identity insert).
    beforeEach(async () => {
      await crowi.model('UserIdentity').deleteMany({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' });
    });

    describe('POST link-start (AC-1, AC-2)', () => {
      it('401s with no credential at all', async () => {
        const res = await request(app).post('/api/auth/providers/fed-oauth2/link-start');
        expect(res.status).toBe(401);
        expect(res.body.authorizationUrl).toBeUndefined();
        expect(res.headers['set-cookie']).toBeUndefined();
      });

      it('403s for a PAT — a valid API credential, but not an interactive session', async () => {
        const { user } = await seedWebUser('fed-linkstart-pat@example.com', 'fed-linkstart-pat');
        const PersonalAccessToken = crowi.model('PersonalAccessToken');
        const { token: pat, tokenHash } = PersonalAccessToken.generateToken();
        await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'link-test', scopes: ['profile:read'] });

        const res = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${pat}`);
        expect(res.status).toBe(403);
        expect(res.headers['set-cookie']).toBeUndefined();
      });

      it('200s for a web session — returns authorizationUrl, sets a flow-specific HttpOnly/SameSite=Lax cookie under /api/auth/providers, and performs zero Mongo writes', async () => {
        const { user, token } = await seedWebUser('fed-linkstart-ok@example.com', 'fed-linkstart-ok');
        const before = await crowi.model('User').findById(user._id).select('authVersion updatedAt');
        const identityCountBefore = await crowi.model('UserIdentity').countDocuments({});

        const res = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.authorizationUrl).toEqual(expect.any(String));
        expect(new URL(res.body.authorizationUrl).host).toBe('idp.example.com');

        const setCookieHeader = extractLinkCookiePair(res);
        expect(setCookieHeader).toMatch(/^crowi\.oauthLinkState\.crowilnk_/);
        const fullHeader = (res.headers['set-cookie'] as string[]).find((c) => c.startsWith('crowi.oauthLinkState.')) as string;
        expect(fullHeader).toContain('HttpOnly');
        expect(fullHeader).toContain('Path=/api/auth/providers');
        expect(fullHeader).toContain('SameSite=Lax');
        expect(fullHeader).toContain('Max-Age=300');

        const after = await crowi.model('User').findById(user._id).select('authVersion updatedAt');
        expect(after?.authVersion).toBe(before?.authVersion);
        expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
        expect(await crowi.model('UserIdentity').countDocuments({})).toBe(identityCountBefore);
      });

      it('404s for an unknown/unconfigured/credential-kind provider', async () => {
        const { token } = await seedWebUser('fed-linkstart-404@example.com', 'fed-linkstart-404');
        expect((await request(app).post('/api/auth/providers/no-such-provider/link-start').set('authorization', `Bearer ${token}`)).status).toBe(404);
        expect((await request(app).post('/api/auth/providers/fed-oauth2-unconfigured/link-start').set('authorization', `Bearer ${token}`)).status).toBe(404);
      });

      describe('cookie/header size admission (AC-16)', () => {
        /**
         * `stateUtil.issueLink` is the sole owner of the exact 4096-byte
         * value budget (unit-tested against the real HMAC signer at
         * `util/federated-auth-state.test.ts:318`); this stub reuses the
         * SAME `> MAX_LINK_STATE_COOKIE_VALUE_BYTES` branch `issueLink`
         * itself runs, but drives it with a deterministic value length
         * instead of a real payload — landing exactly on the 4096/4097
         * boundary via input-length search is unreliable (base64url
         * quantization). Everything else (`planLinkCookiePrune`,
         * `linkCookieOptions`, ...) stays the real implementation, so this
         * only isolates the one branch under test: the HANDLER's own HTTP
         * mapping of `issueLink`'s success/throw outcome at that boundary.
         */
        function stubStateUtilIssuingLinkCookieOfLength(byteLength: number): FederatedAuthStateUtil {
          const real = createFederatedAuthStateUtil(crowi);
          return {
            ...real,
            issueLink: () => {
              const value = 'a'.repeat(byteLength);
              if (Buffer.byteLength(value, 'utf8') > MAX_LINK_STATE_COOKIE_VALUE_BYTES) {
                throw new FederatedLinkStateCookieTooLargeError();
              }
              return value;
            },
          };
        }

        it('a link-state cookie value landing at exactly the 4096-byte budget: 200, with the Set-Cookie value at exactly that length', async () => {
          const { token } = await seedWebUser('fed-linkstart-exact-4096@example.com', randomUsername());
          const stateUtil = stubStateUtilIssuingLinkCookieOfLength(MAX_LINK_STATE_COOKIE_VALUE_BYTES);
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, { stateUtil });

          const res = await localApp.request('/auth/providers/fed-oauth2/link-start', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });

          expect(res.status).toBe(200);
          const body = (await res.json()) as { authorizationUrl: string };
          expect(body.authorizationUrl).toEqual(expect.any(String));
          const setCookieHeader = res.headers.get('set-cookie') as string;
          expect(setCookieHeader).toMatch(/^crowi\.oauthLinkState\./);
          const cookieValue = setCookieHeader.split(';')[0].split('=').slice(1).join('=');
          expect(Buffer.byteLength(cookieValue, 'utf8')).toBe(MAX_LINK_STATE_COOKIE_VALUE_BYTES);
        });

        it('a link-state cookie value that would land 1 byte over the 4096-byte budget: 400 INVALID_REQUEST, no Set-Cookie/authorizationUrl', async () => {
          const { token } = await seedWebUser('fed-linkstart-exact-4097@example.com', randomUsername());
          const stateUtil = stubStateUtilIssuingLinkCookieOfLength(MAX_LINK_STATE_COOKIE_VALUE_BYTES + 1);
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, { stateUtil });

          const res = await localApp.request('/auth/providers/fed-oauth2/link-start', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });

          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code: string }; authorizationUrl?: string };
          expect(body.error.code).toBe('INVALID_REQUEST');
          expect(res.headers.get('set-cookie')).toBeNull();
          expect(body.authorizationUrl).toBeUndefined();
        });

        it('a provider name large enough to push the signed link-state cookie value over its 4096-byte budget: 400 INVALID_REQUEST, no Set-Cookie/authorizationUrl', async () => {
          const hugeProviderName = `fed-huge-${'p'.repeat(6000)}`;
          crowi.getPlugins().auth.register(hugeProviderName, makeOAuth2Driver(), 'test-plugin');
          const { token } = await seedWebUser('fed-linkstart-oversized-cookie@example.com', randomUsername());

          const res = await request(app)
            .post(`/api/auth/providers/${encodeURIComponent(hugeProviderName)}/link-start`)
            .set('authorization', `Bearer ${token}`);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('INVALID_REQUEST');
          expect(res.headers['set-cookie']).toBeUndefined();
          expect(res.body.authorizationUrl).toBeUndefined();
        });

        it('a very large ORDINARY Cookie header alone exceeds the 11 KiB aggregate admission budget: 400 INVALID_REQUEST, no Set-Cookie/authorizationUrl, even though the fresh link cookie itself easily fits within its own 4096-byte cap', async () => {
          const { token } = await seedWebUser('fed-linkstart-oversized-header@example.com', randomUsername());
          const bigOrdinaryCookie = `unrelated_app_cookie=${'x'.repeat(12 * 1024)}`;

          const res = await request(app)
            .post('/api/auth/providers/fed-oauth2/link-start')
            .set('authorization', `Bearer ${token}`)
            .set('Cookie', bigOrdinaryCookie);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('INVALID_REQUEST');
          expect(res.headers['set-cookie']).toBeUndefined();
          expect(res.body.authorizationUrl).toBeUndefined();
        });

        it('6 sequential link-start calls for the SAME session prune an old link cookie once the projected live count would exceed MAX_LINK_FLOW_COOKIE_COUNT=5, and still issue a fresh Set-Cookie', async () => {
          const { token } = await seedWebUser('fed-linkstart-prune@example.com', randomUsername());
          let cookieHeader = '';
          let sawPrune = false;
          for (let i = 0; i < 6; i += 1) {
            const res = await request(app)
              .post('/api/auth/providers/fed-oauth2/link-start')
              .set('authorization', `Bearer ${token}`)
              .set('Cookie', cookieHeader);
            expect(res.status).toBe(200);
            expect(res.body.authorizationUrl).toEqual(expect.any(String));
            const setCookieHeaders = res.headers['set-cookie'] as string[];
            if (setCookieHeaders.some((c) => c.includes('Max-Age=0'))) sawPrune = true;
            // Deliberately never drops a cookie from OUR tracked header just
            // because the server told us (via Max-Age=0) to — a real
            // browser would, but keeping every previously-issued link
            // cookie in the request is what forces the count to actually
            // exceed 5 and exercise the prune path at all.
            const freshPair = setCookieHeaders.map((c) => c.split(';')[0]).find((c) => !c.includes('Max-Age=0'));
            cookieHeader = cookieHeader ? `${cookieHeader}; ${freshPair}` : (freshPair as string);
          }
          expect(sawPrune).toBe(true);
        });
      });
    });

    describe('the old link-via-GET surface is fully retired (AC-21)', () => {
      it('a raw `link` query on GET /start is rejected with 400, any value', async () => {
        const keyPair = await createSenderKeyPair();
        const query = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
        expect((await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}&link=1`).redirects(0)).status).toBe(400);
        expect((await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}&link=anything`).redirects(0)).status).toBe(400);
        expect((await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}&link=`).redirects(0)).status).toBe(400);
      });

      it('ordinary start/callback/handoff without a link query is unaffected', async () => {
        const keyPair = await createSenderKeyPair();
        const query = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
        expect((await request(app).get(`/api/auth/providers/fed-oauth2/start?${query}`).redirects(0)).status).toBe(302);
      });

      it('POST .../link-grants no longer exists', async () => {
        const res = await request(app).post('/api/auth/providers/fed-oauth2/link-grants').send({ handoffChallenge: 'jkt' });
        expect(res.status).toBe(404);
      });
    });

    describe('callback link branch (AC-3, AC-4, AC-5, AC-6)', () => {
      it('completes the full flow: success redirect carries provider + completion code ONLY, and the link branch touches no User/UserIdentity/PendingAuthRegistration', async () => {
        const { user, token } = await seedWebUser('fed-link-callback@example.com', 'fed-link-callback');
        await crowi.model('UserIdentity').deleteMany({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' });
        const identityCountBefore = await crowi.model('UserIdentity').countDocuments({});
        const before = await crowi.model('User').findById(user._id).select('authVersion updatedAt');

        const startRes = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${token}`);
        const cookiePair = extractLinkCookiePair(startRes);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let callbackRes: request.Response;
        try {
          callbackRes = await request(app).get(`/api/auth/providers/fed-oauth2/callback?code=idp-code&state=${state}`).set('Cookie', cookiePair).redirects(0);
        } finally {
          restoreFetch();
        }

        expect(callbackRes.status).toBe(302);
        const location = new URL(callbackRes.headers.location as string);
        expect(location.origin + location.pathname).toBe('https://web.test.example/me');
        expect([...location.searchParams.keys()].sort()).toEqual(['link_completion', 'provider']);
        expect(location.searchParams.get('provider')).toBe('fed-oauth2');
        expect(location.searchParams.get('link_completion')).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // The link cookie is cleared regardless of outcome.
        const clearHeader = (callbackRes.headers['set-cookie'] as string[]).find((c) => c.startsWith('crowi.oauthLinkState.'));
        expect(clearHeader).toContain('Max-Age=0');

        // Callback link branch itself touches nothing yet — identity insert happens only at the confirmation POST.
        expect(await crowi.model('UserIdentity').countDocuments({})).toBe(identityCountBefore);
        const after = await crowi.model('User').findById(user._id).select('authVersion updatedAt');
        expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
      });

      it('a copied authorization URL opened without the link cookie (a different browser) fails without creating a completion or identity (AC-4)', async () => {
        const { token } = await seedWebUser('fed-link-nocookie@example.com', 'fed-link-nocookie');
        const startRes = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${token}`);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        // No Cookie header at all — the victim's browser, not the copying one.
        const callbackRes = await request(app).get(`/api/auth/providers/fed-oauth2/callback?code=idp-code&state=${state}`).redirects(0);

        expect(callbackRes.status).toBe(302);
        const outcome = extractCallbackOutcome(callbackRes);
        expect(outcome.code).toBeNull();
        expect(outcome.linkFailed).toBe('link_failed');
      });

      it('a missing link cookie does not touch the unrelated fixed sign-in cookie — an in-flight ordinary sign-in still completes (AC-5)', async () => {
        // A pre-linked identity so the SHARED app's real registration-mode
        // terminal resolves an ACTIVE user (-> /login/complete) instead of
        // routing to /register/federated — the property under test is
        // "the sign-in cookie survives", independent of which terminal
        // outcome the sign-in itself reaches.
        const signInUser = await seedActiveUser('fed-link-ac5-signin@example.com', 'fed-link-ac5-signin');
        await seedResolvedIdentity(signInUser, 'fed-oauth2', 'oauth2-user-1');
        const { cookie: signInCookie, state: signInState } = await startFlow('fed-oauth2');
        const { token } = await seedWebUser('fed-link-ac5@example.com', 'fed-link-ac5');
        const linkStartRes = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${token}`);
        const linkState = new URL(linkStartRes.body.authorizationUrl).searchParams.get('state') as string;

        // A link-namespace callback with NO link cookie AND (deliberately) the
        // unrelated sign-in cookie riding along — the sign-in cookie must
        // survive untouched.
        const linkCallbackRes = await request(app)
          .get(`/api/auth/providers/fed-oauth2/callback?code=idp-code&state=${linkState}`)
          .set('Cookie', signInCookie)
          .redirects(0);
        expect(extractCallbackOutcome(linkCallbackRes).linkFailed).toBe('link_failed');
        // The sign-in cookie was NOT cleared by the link-branch callback.
        const clearedSignIn = (linkCallbackRes.headers['set-cookie'] as string[] | undefined)?.find((c) => c.startsWith('crowi.oauthState='));
        expect(clearedSignIn).toBeUndefined();

        // The original sign-in flow can still complete afterward.
        const restoreFetch = mockTokenFetch();
        let signInCallbackRes: request.Response;
        try {
          signInCallbackRes = await request(app)
            .get(`/api/auth/providers/fed-oauth2/callback?code=abc&state=${signInState}`)
            .set('Cookie', signInCookie)
            .redirects(0);
        } finally {
          restoreFetch();
        }
        expect(signInCallbackRes.status).toBe(302);
        expect(new URL(signInCallbackRes.headers.location as string).pathname).toBe('/login/complete');
      });

      it('same state, two callback requests: at most one succeeds with a completion code, the loser gets a generic link failure (AC-6)', async () => {
        const { token } = await seedWebUser('fed-link-ac6@example.com', 'fed-link-ac6');
        const startRes = await request(app).post('/api/auth/providers/fed-oauth2/link-start').set('authorization', `Bearer ${token}`);
        const cookiePair = extractLinkCookiePair(startRes);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let first: request.Response;
        let second: request.Response;
        try {
          [first, second] = await Promise.all([
            request(app).get(`/api/auth/providers/fed-oauth2/callback?code=idp-code-1&state=${state}`).set('Cookie', cookiePair).redirects(0),
            request(app).get(`/api/auth/providers/fed-oauth2/callback?code=idp-code-2&state=${state}`).set('Cookie', cookiePair).redirects(0),
          ]);
        } finally {
          restoreFetch();
        }
        const outcomes = [extractCallbackOutcome(first), extractCallbackOutcome(second)];
        const winners = outcomes.filter((o) => o.code != null);
        const losers = outcomes.filter((o) => o.code == null);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0].linkFailed).toBe('link_failed');
      });

      it('an OAuth2 fetchProfile rejection collapses to the SAME generic link failure — never exposes which protocol step failed', async () => {
        const rejecting = { ...makeOAuth2Driver(), fetchProfile: async () => ({ ok: false as const, reason: 'org membership required' }) };
        crowi.getPlugins().auth.register('fed-link-reject', rejecting, 'test-plugin');
        const { token } = await seedWebUser('fed-link-reject-user@example.com', 'fed-link-reject-user');

        const startRes = await request(app).post('/api/auth/providers/fed-link-reject/link-start').set('authorization', `Bearer ${token}`);
        const cookiePair = extractLinkCookiePair(startRes);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let callbackRes: request.Response;
        try {
          callbackRes = await request(app)
            .get(`/api/auth/providers/fed-link-reject/callback?code=idp-code&state=${state}`)
            .set('Cookie', cookiePair)
            .redirects(0);
        } finally {
          restoreFetch();
        }
        const outcome = extractCallbackOutcome(callbackRes);
        expect(outcome.code).toBeNull();
        expect(outcome.linkFailed).toBe('link_failed');
      });

      it('an unbounded profile.email that would push the completion record over its byte budget is normalized away (omitted) rather than failing the callback (design decision 22) — the confirmation GET still 200s, just without accountLabel', async () => {
        crowi.getPlugins().auth.register(
          'fed-huge-email',
          makeOAuth2Driver({
            fetchProfile: async () => ({ ok: true as const, profile: { providerUserId: 'huge-email-sub', email: `${'a'.repeat(5000)}@example.com` } }),
          }),
          'test-plugin',
        );
        const { token } = await seedWebUser('fed-hugeemail@example.com', randomUsername());
        await crowi.model('UserIdentity').deleteMany({ provider: 'fed-huge-email', providerUserId: 'huge-email-sub' });

        const { code } = await runFullLinkFlow('fed-huge-email', token);

        const getRes = await request(app).get(`/api/auth/providers/fed-huge-email/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.provider).toBe('fed-huge-email');
        expect(getRes.body.accountLabel).toBeUndefined();
      });
    });

    describe('GET link-completions/{code} — confirmation (non-destructive)', () => {
      it('unauthenticated + malformed code: 401 (middleware runs before validation)', async () => {
        const res = await request(app).get('/api/auth/providers/fed-oauth2/link-completions/not-well-formed');
        expect(res.status).toBe(401);
      });

      it('web JWT + malformed code: 400 VALIDATION_ERROR, and the store is never touched', async () => {
        const { token } = await seedWebUser('fed-getcompletion-malformed@example.com', 'fed-getcompletion-malformed');
        const { localApp, store } = buildLocalAppWithSpiedStore();
        const res = await localApp.request('/auth/providers/fed-oauth2/link-completions/not-well-formed', {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(store.find).not.toHaveBeenCalled();
      });

      it('PAT + malformed code: touches lastUsedAt, then 400, handler/store untouched', async () => {
        const { user } = await seedWebUser('fed-getcompletion-pat@example.com', 'fed-getcompletion-pat');
        const PersonalAccessToken = crowi.model('PersonalAccessToken');
        const { token: pat, tokenHash } = PersonalAccessToken.generateToken();
        const patDoc = await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'get-completion-test', scopes: ['profile:read'] });
        expect(patDoc.lastUsedAt).toBeFalsy();

        const { localApp, store } = buildLocalAppWithSpiedStore();
        const res = await localApp.request('/auth/providers/fed-oauth2/link-completions/not-well-formed', { headers: { authorization: `Bearer ${pat}` } });
        expect(res.status).toBe(400);
        expect(store.find).not.toHaveBeenCalled();

        const refreshed = await PersonalAccessToken.findById(patDoc._id);
        expect(refreshed?.lastUsedAt).toBeInstanceOf(Date);
      });

      it('valid PAT/OAuth credential with a WELL-FORMED code: 403 (non-web session)', async () => {
        const { user } = await seedWebUser('fed-getcompletion-validpat@example.com', 'fed-getcompletion-validpat');
        const PersonalAccessToken = crowi.model('PersonalAccessToken');
        const { token: pat, tokenHash } = PersonalAccessToken.generateToken();
        await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'valid-pat-test', scopes: ['profile:read'] });
        const wellFormedCode = 'a'.repeat(43);

        const res = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${wellFormedCode}`).set('authorization', `Bearer ${pat}`);
        expect(res.status).toBe(403);
      });

      it('404s for a mismatched user/provider/authVersion, and for a never-issued code', async () => {
        const { token: userAToken } = await seedWebUser('fed-getcompletion-usera@example.com', 'fed-getcompletion-usera');
        const { token: userBToken } = await seedWebUser('fed-getcompletion-userb@example.com', 'fed-getcompletion-userb');
        const { code } = await runFullLinkFlow('fed-oauth2', userAToken);

        // Never issued.
        const neverIssued = await request(app)
          .get(`/api/auth/providers/fed-oauth2/link-completions/${'z'.repeat(43)}`)
          .set('authorization', `Bearer ${userAToken}`);
        expect(neverIssued.status).toBe(404);

        // Wrong user.
        const wrongUser = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${userBToken}`);
        expect(wrongUser.status).toBe(404);

        // Wrong provider (path says a different, but enabled, provider name).
        const wrongProvider = await request(app).get(`/api/auth/providers/fed-oidc/link-completions/${code}`).set('authorization', `Bearer ${userAToken}`);
        expect(wrongProvider.status).toBe(404);
      });

      it("404s when the caller's CURRENT authVersion no longer matches the one the record was issued under (a password reset landed between link-start and this GET)", async () => {
        const { user, token } = await seedWebUser('fed-getcompletion-authver@example.com', 'fed-getcompletion-authver');
        const { code } = await runFullLinkFlow('fed-oauth2', token);

        user.authVersion = (user.authVersion ?? 0) + 1;
        await user.save();
        const freshToken = webTokenFor(user);

        const res = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${freshToken}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      });

      it("200s with the caller's own pending completion, non-destructively (repeatable)", async () => {
        const { token } = await seedWebUser('fed-getcompletion-ok@example.com', 'fed-getcompletion-ok');
        const { code } = await runFullLinkFlow('fed-oauth2', token);

        const first = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(first.status).toBe(200);
        expect(first.body.provider).toBe('fed-oauth2');
        expect(first.body.accountLabel).toBe('oauth2-user@example.com');

        // Repeatable — GET does not consume.
        const second = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
      });

      it("409s LINK_COMPLETION_CONSUMED for the caller's own already-consumed code", async () => {
        const { token } = await seedWebUser('fed-getcompletion-consumed@example.com', 'fed-getcompletion-consumed');
        const { code } = await runFullLinkFlow('fed-oauth2', token);
        const postRes = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(postRes.status).toBe(200);

        const getRes = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(409);
        expect(getRes.body.error.code).toBe('LINK_COMPLETION_CONSUMED');
      });
    });

    describe('POST link-completions/{code} — final confirmation (AC-9, AC-10, AC-11, AC-12, AC-13, AC-14)', () => {
      it('unauthenticated + malformed code: 401', async () => {
        const res = await request(app).post('/api/auth/providers/fed-oauth2/link-completions/not-well-formed');
        expect(res.status).toBe(401);
      });

      it('web JWT + malformed code: 400 VALIDATION_ERROR, store never touched', async () => {
        const { token } = await seedWebUser('fed-postcompletion-malformed@example.com', 'fed-postcompletion-malformed');
        const { localApp, store } = buildLocalAppWithSpiedStore();
        const res = await localApp.request('/auth/providers/fed-oauth2/link-completions/not-well-formed', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(400);
        expect(store.find).not.toHaveBeenCalled();
        expect(store.consumeVerified).not.toHaveBeenCalled();
      });

      it('valid PAT/OAuth credential with a well-formed code: 403', async () => {
        const { user } = await seedWebUser('fed-postcompletion-pat@example.com', 'fed-postcompletion-pat');
        const PersonalAccessToken = crowi.model('PersonalAccessToken');
        const { token: pat, tokenHash } = PersonalAccessToken.generateToken();
        await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'post-pat-test', scopes: ['profile:read'] });
        const res = await request(app)
          .post(`/api/auth/providers/fed-oauth2/link-completions/${'a'.repeat(43)}`)
          .set('authorization', `Bearer ${pat}`);
        expect(res.status).toBe(403);
      });

      it('PAT + malformed code: touches lastUsedAt, then 400, handler/store untouched (same ordering as the GET side)', async () => {
        const { user } = await seedWebUser('fed-postcompletion-pat-malformed@example.com', 'fed-postcompletion-pat-malformed');
        const PersonalAccessToken = crowi.model('PersonalAccessToken');
        const { token: pat, tokenHash } = PersonalAccessToken.generateToken();
        const patDoc = await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'post-completion-malformed-test', scopes: ['profile:read'] });
        expect(patDoc.lastUsedAt).toBeFalsy();

        const { localApp, store } = buildLocalAppWithSpiedStore();
        const res = await localApp.request('/auth/providers/fed-oauth2/link-completions/not-well-formed', {
          method: 'POST',
          headers: { authorization: `Bearer ${pat}` },
        });
        expect(res.status).toBe(400);
        expect(store.find).not.toHaveBeenCalled();
        expect(store.consumeVerified).not.toHaveBeenCalled();

        const refreshed = await PersonalAccessToken.findById(patDoc._id);
        expect(refreshed?.lastUsedAt).toBeInstanceOf(Date);
      });

      it('404s for a different user or provider than the one bound to the code, and never consumes/links', async () => {
        const { token: userAToken } = await seedWebUser('fed-postcompletion-usera@example.com', 'fed-postcompletion-usera');
        const { token: userBToken } = await seedWebUser('fed-postcompletion-userb@example.com', 'fed-postcompletion-userb');
        const { code } = await runFullLinkFlow('fed-oauth2', userAToken);

        const wrongUser = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${userBToken}`);
        expect(wrongUser.status).toBe(404);

        // The victim (userA) can still confirm it afterward — the code was never actually consumed.
        const legit = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${userAToken}`);
        expect(legit.status).toBe(200);
      });

      it('same code, concurrent POSTs: exactly one consume winner, the loser gets a replay-derived result (design decisions 17/18/19, AC-14)', async () => {
        const { token } = await seedWebUser('fed-postcompletion-race@example.com', 'fed-postcompletion-race');
        const { code } = await runFullLinkFlow('fed-oauth2', token);

        const [first, second] = await Promise.all([
          request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`),
          request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`),
        ]);
        // The consume winner always gets 200 immediately. The loser re-derives
        // its result from the DB (design decision 17/18): it is the SAME 200 if
        // the winner's terminal insert already landed by the time the loser
        // reads, or a transient 409 FEDERATED_LINK_NOT_LINKED if the loser reads
        // between the winner's consume and its terminal insert — that window is
        // sanctioned by design decision 19 / AC-14 (no lease/poll to close it).
        const statuses = [first.status, second.status];
        for (const res of [first, second]) {
          if (res.status === 200) {
            expect(res.body).toEqual({ result: 'linked' });
          } else {
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('FEDERATED_LINK_NOT_LINKED');
          }
        }
        // The winner is always 200 — the race can only ever cost the LOSER its 200.
        expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
        expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' })).toBe(1);
      });

      it('winner: consumes, fresh-reads User, links, returns 200 {result:"linked"}; a same-owner re-POST after completion is also 200 and creates no second row', async () => {
        const { user, token } = await seedWebUser('fed-postcompletion-winner@example.com', 'fed-postcompletion-winner');
        await crowi.model('UserIdentity').deleteMany({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' });
        const { code } = await runFullLinkFlow('fed-oauth2', token);

        const res = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: 'linked' });
        const identity = await crowi.model('UserIdentity').findOne({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' });
        expect(String(identity?.userId)).toBe(String(user._id));

        const replay = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(replay.status).toBe(200);
        expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' })).toBe(1);
      });

      // Note: a user SUSPENDED before sending this POST never reaches this
      // handler's own fence at all — `createJwtAuth` re-reads `User` fresh
      // on every request and already 403s a suspended session's JWT at the
      // middleware boundary. The handler-level fence exists for the tight
      // window strictly INSIDE one request (between `consumeVerified` and
      // this fresh read) — the authVersion case below exercises the same
      // guard clause (`freshUser.status !== ACTIVE || authVersion
      // mismatch`) via a reachable HTTP scenario.
      it('fresh User authVersion changed since link-start (password reset + fresh re-login before confirming): 409 FEDERATED_LINK_AUTH_STATE_CHANGED, code consumed, no identity inserted', async () => {
        const { user, token } = await seedWebUser('fed-postcompletion-authver@example.com', 'fed-postcompletion-authver');
        const { code } = await runFullLinkFlow('fed-oauth2', token);

        // The record still carries the OLD authVersion from link-start.
        // Bumping it and minting a FRESH token (as a real re-login after a
        // password reset would) passes `createJwtAuth`'s own current-
        // authVersion check, so the mismatch is caught ONLY by this
        // handler's own fresh-read fence against the STORED record.
        user.authVersion = (user.authVersion ?? 0) + 1;
        await user.save();
        const freshToken = webTokenFor(user);

        const res = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${freshToken}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FEDERATED_LINK_AUTH_STATE_CHANGED');
        expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' })).toBe(0);

        // The code is consumed (焼き切り) even on this fence failure — a retry with the same code never succeeds later either.
        const retry = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${freshToken}`);
        expect(retry.status).toBe(409);
      });

      describe('fresh User fence — missing/suspended/read-throw/forced interleave (AC-11)', () => {
        /**
         * Intercepts the SECOND `User.findById(targetUserId)` call issued
         * while this spy is active — the handler's OWN fresh-read fence,
         * which always runs strictly AFTER `createJwtAuth`'s middleware-
         * level read (call #1) already authenticated the SAME request — and
         * runs `sideEffect` immediately before THAT call's result resolves.
         * Overrides the returned Query's `.exec()` (verified against the
         * installed mongoose version: `Query.prototype.then` delegates to
         * `this.exec()`) rather than wrapping `findById` itself in a plain
         * async function, which would replace the real chainable `Query`
         * with a bare `Promise` and break the handler's own
         * `.select('status authVersion')` chaining.
         */
        function interceptSecondFreshUserRead(targetUserId: unknown, sideEffect: () => Promise<void>): jest.SpyInstance {
          const User = crowi.model('User');
          const originalFindById = User.findById.bind(User);
          let callsForTarget = 0;
          return jest.spyOn(User, 'findById').mockImplementation(((...args: unknown[]) => {
            const query = originalFindById(...(args as Parameters<typeof User.findById>));
            if (String(args[0]) !== String(targetUserId)) return query;
            callsForTarget += 1;
            if (callsForTarget !== 2) return query;
            const execTarget = query as unknown as { exec: () => Promise<unknown> };
            const originalExec = execTarget.exec.bind(execTarget);
            execTarget.exec = async () => {
              await sideEffect();
              return originalExec();
            };
            return query;
          }) as typeof User.findById);
        }

        it("the fresh read is MISSING (the User was deleted between the JWT middleware's read and this handler's own fresh read): 409 FEDERATED_LINK_AUTH_STATE_CHANGED, code consumed, no identity inserted", async () => {
          const { user, token } = await seedWebUser('fed-postcompletion-missing@example.com', randomUsername());
          const { code } = await runFullLinkFlow('fed-oauth2', token);
          const User = crowi.model('User');

          const spy = interceptSecondFreshUserRead(user._id, async () => {
            await User.deleteOne({ _id: user._id });
          });
          try {
            const res = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('FEDERATED_LINK_AUTH_STATE_CHANGED');
          } finally {
            spy.mockRestore();
          }
          expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' })).toBe(0);
          // (No follow-up GET here: the SAME token can no longer even
          // authenticate once its user is deleted — `createJwtAuth`'s own
          // read now 401s before reaching this handler at all — so "was the
          // code consumed" is verified via the identity-count assertion
          // above instead; the "read throws" case below covers the
          // consumed-despite-failure check with a still-ACTIVE user.)
        });

        it("the fresh read observes a status the middleware's earlier read did not (SUSPENDED between the two reads): 409 FEDERATED_LINK_AUTH_STATE_CHANGED, code consumed, no identity inserted", async () => {
          const { user, token } = await seedWebUser('fed-postcompletion-suspended@example.com', randomUsername());
          const { code } = await runFullLinkFlow('fed-oauth2', token);
          const User = crowi.model('User');

          const spy = interceptSecondFreshUserRead(user._id, async () => {
            await User.updateOne({ _id: user._id }, { status: User.STATUS_SUSPENDED });
          });
          try {
            const res = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('FEDERATED_LINK_AUTH_STATE_CHANGED');
          } finally {
            spy.mockRestore();
            await User.updateOne({ _id: user._id }, { status: User.STATUS_ACTIVE });
          }
          expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-oauth2', providerUserId: 'oauth2-user-1' })).toBe(0);
        });

        it('the fresh read THROWS (infra failure): 500, but the code is still consumed — a retry never re-attempts consume', async () => {
          const { user, token } = await seedWebUser('fed-postcompletion-readthrow@example.com', randomUsername());
          const { code } = await runFullLinkFlow('fed-oauth2', token);

          const spy = interceptSecondFreshUserRead(user._id, async () => {
            throw new Error('simulated fresh-read infra failure');
          });
          try {
            const res = await request(app).post(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
            expect(res.status).toBe(500);
          } finally {
            spy.mockRestore();
          }

          const getRes = await request(app).get(`/api/auth/providers/fed-oauth2/link-completions/${code}`).set('authorization', `Bearer ${token}`);
          expect(getRes.status).toBe(409);
          expect(getRes.body.error.code).toBe('LINK_COMPLETION_CONSUMED');
        });

        it('the fresh read SUCCEEDS (ACTIVE, matching authVersion) but a suspend/authVersion-bump lands AFTER that read and BEFORE the terminal insert: the insert still lands, no compensating delete (design decision 15, the sanctioned few-ms window)', async () => {
          crowi
            .getPlugins()
            .auth.register(
              'fed-ac11-interleave',
              makeOAuth2Driver({ fetchProfile: async () => ({ ok: true as const, profile: { providerUserId: 'ac11-interleave-sub' } }) }),
              'test-plugin',
            );
          const { user, token } = await seedWebUser('fed-ac11-interleave@example.com', randomUsername());
          await crowi.model('UserIdentity').deleteMany({ provider: 'fed-ac11-interleave', providerUserId: 'ac11-interleave-sub' });

          const User = crowi.model('User');
          const realTerminal = createAuthProviderLinkingTerminal(crowi);
          const interleavingTerminal: AuthProviderLinkingTerminal = {
            async link(input) {
              // Simulates a suspend/authVersion bump landing in the tiny
              // window AFTER this request's own fresh-read fence already
              // passed (it is that fence's job to catch a change BEFORE the
              // insert, not one that happens strictly after — see design
              // decision 15).
              await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1 }, status: User.STATUS_SUSPENDED });
              return realTerminal.link(input);
            },
          };
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, { linkingTerminal: interleavingTerminal });

          try {
            const { code } = await runFullLinkFlowViaLocalApp(localApp, 'fed-ac11-interleave', token);
            const res = await localApp.request(`/auth/providers/fed-ac11-interleave/link-completions/${code}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ result: 'linked' });
          } finally {
            await User.updateOne({ _id: user._id }, { status: User.STATUS_ACTIVE });
          }

          // The row inserted by the terminal is NOT compensating-deleted —
          // it remains, even though the user is (as of just now) suspended.
          const identity = await crowi.model('UserIdentity').findOne({ provider: 'fed-ac11-interleave', providerUserId: 'ac11-interleave-sub' });
          expect(String(identity?.userId)).toBe(String(user._id));
        });
      });

      describe('deterministic not-linked -> linked replay convergence (AC-14)', () => {
        it("a replay whose DB read lands strictly BEFORE the original winner's terminal insert gets the sanctioned transient 409 FEDERATED_LINK_NOT_LINKED; a LATER replay of the SAME code converges to 200 linked once that insert completes — no lease/poll", async () => {
          crowi
            .getPlugins()
            .auth.register(
              'fed-ac14',
              makeOAuth2Driver({ fetchProfile: async () => ({ ok: true as const, profile: { providerUserId: 'ac14-sub-1' } }) }),
              'test-plugin',
            );
          const { user, token } = await seedWebUser('fed-ac14-convergence@example.com', randomUsername());
          await crowi.model('UserIdentity').deleteMany({ provider: 'fed-ac14', providerUserId: 'ac14-sub-1' });

          let winnerParked: (() => void) | null = null;
          const winnerParkedPromise = new Promise<void>((resolve) => {
            winnerParked = resolve;
          });
          let releaseWinner: (() => void) | null = null;
          const winnerGate = new Promise<void>((resolve) => {
            releaseWinner = resolve;
          });
          const realTerminal = createAuthProviderLinkingTerminal(crowi);
          const gatedTerminal: AuthProviderLinkingTerminal = {
            async link(input) {
              // Parks HERE — the code is already consumed (the winner's
              // `consumeVerified` already won) and the fresh-User fence
              // already passed, but the `UserIdentity` row does not exist
              // yet. A replay that reads the DB while parked here is
              // exactly the window design decision 19 / AC-14 sanctions.
              winnerParked?.();
              await winnerGate;
              return realTerminal.link(input);
            },
          };
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, { linkingTerminal: gatedTerminal });

          const { code } = await runFullLinkFlowViaLocalApp(localApp, 'fed-ac14', token);

          const winnerPromise = localApp.request(`/auth/providers/fed-ac14/link-completions/${code}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          await winnerParkedPromise; // deterministic: the winner consumed and is parked strictly before its own insert.

          const replayBeforeInsert = await localApp.request(`/auth/providers/fed-ac14/link-completions/${code}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(replayBeforeInsert.status).toBe(409);
          const replayBeforeBody = (await replayBeforeInsert.json()) as { error: { code: string } };
          expect(replayBeforeBody.error.code).toBe('FEDERATED_LINK_NOT_LINKED');

          releaseWinner?.();
          const winnerRes = await winnerPromise;
          expect(winnerRes.status).toBe(200);
          expect(await winnerRes.json()).toEqual({ result: 'linked' });

          const replayAfterInsert = await localApp.request(`/auth/providers/fed-ac14/link-completions/${code}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(replayAfterInsert.status).toBe(200);
          expect(await replayAfterInsert.json()).toEqual({ result: 'linked' });

          expect(await crowi.model('UserIdentity').countDocuments({ provider: 'fed-ac14', providerUserId: 'ac14-sub-1' })).toBe(1);
          expect(String((await crowi.model('UserIdentity').findOne({ provider: 'fed-ac14', providerUserId: 'ac14-sub-1' }))?.userId)).toBe(String(user._id));
        });
      });

      describe('already-consumed replay re-derives its result from the DB (design decision 17/18), via a fake store deterministically reporting already_consumed', () => {
        /** A fake store whose `find`/`consumeVerified` always report the SAME fixed record as already-consumed — isolates `resolveAuthProviderLinkReplay`'s DB re-derivation from the store's own atomicity (already covered in `link-completion.test.ts`). */
        function buildAlreadyConsumedStore(record: { userId: string; provider: string; providerUserId: string }) {
          const fullRecord = {
            ...record,
            authVersion: 0,
            accountLabel: undefined,
            issuedAt: 0,
            authorizationExpiresAt: 300_000,
            consumedAt: 100,
            retentionExpiresAt: 300_100,
          };
          return {
            issue: jest.fn(async () => ({ ok: false as const, reason: 'state_expired' as const })),
            find: jest.fn(async () => fullRecord),
            consumeVerified: jest.fn(async () => ({ ok: false as const, reason: 'already_consumed' as const })),
          };
        }

        it('same owner as the record -> 200 linked', async () => {
          const { user, token } = await seedWebUser('fed-replay-same@example.com', 'fed-replay-same');
          await crowi.model('UserIdentity').deleteMany({ provider: 'replay-provider-1', providerUserId: 'replay-sub-1' });
          await crowi.model('UserIdentity').create({ userId: user._id, provider: 'replay-provider-1', providerUserId: 'replay-sub-1' });
          const store = buildAlreadyConsumedStore({ userId: user._id.toString(), provider: 'replay-provider-1', providerUserId: 'replay-sub-1' });
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
            linkCompletionRuntimeFactory: async () => ({ store, now: async () => Date.now() }),
          });

          const res = await localApp.request(`/auth/providers/replay-provider-1/link-completions/${'a'.repeat(43)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ result: 'linked' });
        });

        it('a DIFFERENT owner holds the exact provider account -> 409 FEDERATED_IDENTITY_IN_USE', async () => {
          const { user: callerUser, token } = await seedWebUser('fed-replay-other@example.com', 'fed-replay-other');
          const otherOwner = await seedActiveUser('fed-replay-other-owner@example.com', 'fed-replay-other-owner');
          await crowi.model('UserIdentity').deleteMany({ provider: 'replay-provider-2', providerUserId: 'replay-sub-2' });
          // The DB row is owned by someone ELSE — the replay must re-derive
          // this from the DB (not trust the record's own userId as "linked").
          await crowi.model('UserIdentity').create({ userId: otherOwner._id, provider: 'replay-provider-2', providerUserId: 'replay-sub-2' });
          // The store's record names the CALLING user (so the binding pre-check passes and the request actually reaches the replay resolver).
          const store = buildAlreadyConsumedStore({ userId: callerUser._id.toString(), provider: 'replay-provider-2', providerUserId: 'replay-sub-2' });
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
            linkCompletionRuntimeFactory: async () => ({ store, now: async () => Date.now() }),
          });

          const res = await localApp.request(`/auth/providers/replay-provider-2/link-completions/${'a'.repeat(43)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(409);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('FEDERATED_IDENTITY_IN_USE');
        });

        it('exact subject absent, but the caller already has a DIFFERENT account of the same provider linked -> 409 FEDERATED_IDENTITY_IN_USE (provider_slot_taken)', async () => {
          const { user, token } = await seedWebUser('fed-replay-slot@example.com', 'fed-replay-slot');
          await crowi.model('UserIdentity').deleteMany({ userId: user._id, provider: 'replay-provider-3' });
          // A row exists for this user+provider, but with a DIFFERENT providerUserId than the record's — the exact-subject read (provider+providerUserId) misses, the provider-slot read (userId+provider) hits with a mismatched subject.
          await crowi.model('UserIdentity').create({ userId: user._id, provider: 'replay-provider-3', providerUserId: 'a-different-sub' });
          const store = buildAlreadyConsumedStore({ userId: user._id.toString(), provider: 'replay-provider-3', providerUserId: 'replay-sub-3' });
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
            linkCompletionRuntimeFactory: async () => ({ store, now: async () => Date.now() }),
          });

          const res = await localApp.request(`/auth/providers/replay-provider-3/link-completions/${'a'.repeat(43)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(409);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('FEDERATED_IDENTITY_IN_USE');
        });

        it('no row for the record subject at all -> 409 FEDERATED_LINK_NOT_LINKED', async () => {
          const { user, token } = await seedWebUser('fed-replay-none@example.com', 'fed-replay-none');
          await crowi.model('UserIdentity').deleteMany({ userId: user._id, provider: 'replay-provider-4' });
          const store = buildAlreadyConsumedStore({ userId: user._id.toString(), provider: 'replay-provider-4', providerUserId: 'replay-sub-4' });
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
            linkCompletionRuntimeFactory: async () => ({ store, now: async () => Date.now() }),
          });

          const res = await localApp.request(`/auth/providers/replay-provider-4/link-completions/${'a'.repeat(43)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(409);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('FEDERATED_LINK_NOT_LINKED');
        });
      });

      it('never-issued, and a retention-expired code all collapse to the same 404 body — no result-unknown code exists', async () => {
        const { token } = await seedWebUser('fed-postcompletion-404s@example.com', 'fed-postcompletion-404s');
        const neverIssued = await request(app)
          .post(`/api/auth/providers/fed-oauth2/link-completions/${'q'.repeat(43)}`)
          .set('authorization', `Bearer ${token}`);
        expect(neverIssued.status).toBe(404);
        expect(neverIssued.body.error.code).toBe('NOT_FOUND');

        const { localApp } = buildLocalAppWithSpiedStore(); // find() always resolves null -> same 404, regardless of WHY.
        const res = await localApp.request(`/auth/providers/fed-oauth2/link-completions/${'r'.repeat(43)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
    });

    describe('provider foo:bar exercises the full link flow (AC-20)', () => {
      it('link-start -> callback -> GET -> POST all succeed for a provider name containing a colon', async () => {
        crowi
          .getPlugins()
          .auth.register(
            'foo:bar',
            makeOAuth2Driver({ fetchProfile: async () => ({ ok: true as const, profile: { providerUserId: 'foobar-sub-1' } }) }),
            'test-plugin',
          );
        const { user, token } = await seedWebUser('fed-foobar@example.com', 'fed-foobar');
        await crowi.model('UserIdentity').deleteMany({ provider: 'foo:bar', providerUserId: 'foobar-sub-1' });

        const startRes = await request(app).post('/api/auth/providers/foo%3Abar/link-start').set('authorization', `Bearer ${token}`);
        expect(startRes.status).toBe(200);
        const cookiePair = extractLinkCookiePair(startRes);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let callbackRes: request.Response;
        try {
          callbackRes = await request(app).get(`/api/auth/providers/foo%3Abar/callback?code=idp-code&state=${state}`).set('Cookie', cookiePair).redirects(0);
        } finally {
          restoreFetch();
        }
        const { code, provider } = extractCallbackOutcome(callbackRes);
        expect(provider).toBe('foo:bar');
        expect(code).toBeTruthy();

        const getRes = await request(app).get(`/api/auth/providers/foo%3Abar/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.provider).toBe('foo:bar');

        const postRes = await request(app).post(`/api/auth/providers/foo%3Abar/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(postRes.status).toBe(200);
        const identity = await crowi.model('UserIdentity').findOne({ provider: 'foo:bar', providerUserId: 'foobar-sub-1' });
        expect(String(identity?.userId)).toBe(String(user._id));
      });
    });

    describe.each([
      ['a/b', 'a%2Fb'],
      ['a?b', 'a%3Fb'],
      ['a#b', 'a%23b'],
      // A provider name that itself literally CONTAINS a percent sign —
      // distinct from the three above, which use %-escapes to encode a
      // reserved character. The single `encodeURIComponent` a real caller
      // (web's shared codec, or this raw HTTP request) applies turns the
      // literal `%` into `%25`, and Hono's own single decode must recover
      // exactly `a%2Fb` — not the two-character-decoded `a/b`.
      ['a%2Fb', 'a%252Fb'],
    ])('provider %j round-trips through the full link flow over REAL HTTP (AC-20) — encoded path segment %j', (rawProviderName, encodedSegment) => {
      it('link-start -> callback -> GET -> POST all resolve the RAW registered provider; the request never collapses into a different endpoint', async () => {
        const providerUserId = `sub-${encodedSegment}`;
        crowi
          .getPlugins()
          .auth.register(rawProviderName, makeOAuth2Driver({ fetchProfile: async () => ({ ok: true as const, profile: { providerUserId } }) }), 'test-plugin');
        const { user, token } = await seedWebUser(`fed-wire-${encodedSegment.replace(/[^a-z0-9]/gi, '')}@example.com`, randomUsername());
        await crowi.model('UserIdentity').deleteMany({ provider: rawProviderName, providerUserId });

        const startRes = await request(app).post(`/api/auth/providers/${encodedSegment}/link-start`).set('authorization', `Bearer ${token}`);
        expect(startRes.status).toBe(200);
        const cookiePair = extractLinkCookiePair(startRes);
        const state = new URL(startRes.body.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let callbackRes: request.Response;
        try {
          callbackRes = await request(app)
            .get(`/api/auth/providers/${encodedSegment}/callback?code=idp-code&state=${state}`)
            .set('Cookie', cookiePair)
            .redirects(0);
        } finally {
          restoreFetch();
        }
        const { code, provider } = extractCallbackOutcome(callbackRes);
        // The RAW registered name, recovered from Hono's own single decode
        // — not the encoded wire segment, and not a %-collapsed variant.
        expect(provider).toBe(rawProviderName);
        expect(code).toBeTruthy();

        const getRes = await request(app).get(`/api/auth/providers/${encodedSegment}/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.provider).toBe(rawProviderName);

        const postRes = await request(app).post(`/api/auth/providers/${encodedSegment}/link-completions/${code}`).set('authorization', `Bearer ${token}`);
        expect(postRes.status).toBe(200);
        const identity = await crowi.model('UserIdentity').findOne({ provider: rawProviderName, providerUserId });
        expect(String(identity?.userId)).toBe(String(user._id));
      });
    });

    describe('multi-instance runtime topology (AC-19)', () => {
      it('a declared multi-instance topology with no Redis client 500s link-start, with no cookie/authorizationUrl', async () => {
        const { token } = await seedWebUser('fed-topology-multi@example.com', 'fed-topology-multi');
        const original = process.env.CROWI_MULTI_INSTANCE;
        process.env.CROWI_MULTI_INSTANCE = 'true';
        try {
          // A fresh local app so its OWN memoized runtime resolves under the declared env — crowi.redis stays null in this test harness.
          const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi);
          const res = await localApp.request('/auth/providers/fed-oauth2/link-start', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
          expect(res.status).toBe(500);
          expect(res.headers.get('set-cookie')).toBeNull();
        } finally {
          if (original === undefined) delete process.env.CROWI_MULTI_INSTANCE;
          else process.env.CROWI_MULTI_INSTANCE = original;
        }
      });

      it('the 4 link handlers share exactly ONE memoized runtime construction per registered app', async () => {
        const { token } = await seedWebUser('fed-topology-shared@example.com', 'fed-topology-shared');
        let constructCalls = 0;
        const store = createLinkCompletionStore();
        const localApp = registerFederatedAuthRoutes(createHonoApp(), crowi, {
          linkCompletionRuntimeFactory: async () => {
            constructCalls += 1;
            return { store, now: async () => Date.now() };
          },
        });

        const startRes = await localApp.request('/auth/providers/fed-oauth2/link-start', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
        expect(constructCalls).toBe(1);
        const startBody = (await startRes.json()) as { authorizationUrl: string };
        const cookieHeader = (startRes.headers.get('set-cookie') as string).split(';')[0];
        const state = new URL(startBody.authorizationUrl).searchParams.get('state') as string;

        const restoreFetch = mockTokenFetch();
        let callbackRes: Response;
        try {
          callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=idp-code&state=${state}`, { headers: { cookie: cookieHeader } });
        } finally {
          restoreFetch();
        }
        expect(constructCalls).toBe(1);
        const { code } = extractCallbackOutcome({ headers: { location: callbackRes.headers.get('location') as string } });
        expect(code).toBeTruthy();

        const getRes = await localApp.request(`/auth/providers/fed-oauth2/link-completions/${code}`, { headers: { authorization: `Bearer ${token}` } });
        expect(getRes.status).toBe(200);
        expect(constructCalls).toBe(1);

        const postRes = await localApp.request(`/auth/providers/fed-oauth2/link-completions/${code}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(postRes.status).toBe(200);
        expect(constructCalls).toBe(1);
      });
    });

    describe('AC-5: unlink over HTTP', () => {
      it('204s and removes the identity for a password-holding user, then 404s on a second call', async () => {
        const { user, token } = await seedWebUser('fed-unlink-ok@example.com', 'fed-unlink-ok');
        await crowi.model('UserIdentity').deleteMany({ provider: 'fed-unlink', providerUserId: 'sub-unlink-ok' });
        await crowi.model('UserIdentity').create({ userId: user._id, provider: 'fed-unlink', providerUserId: 'sub-unlink-ok' });

        const res = await request(app).delete('/api/auth/providers/fed-unlink/identity').set('authorization', `Bearer ${token}`);
        expect(res.status).toBe(204);
        expect(await crowi.model('UserIdentity').countDocuments({ userId: user._id, provider: 'fed-unlink' })).toBe(0);

        const again = await request(app).delete('/api/auth/providers/fed-unlink/identity').set('authorization', `Bearer ${token}`);
        expect(again.status).toBe(404);
      });

      it('409s with PASSWORD_REQUIRED — and keeps the identity — when the account has no password to fall back on', async () => {
        const [user] = (await Fixture.generate('User', [
          { name: 'No Password', username: randomUsername(), email: 'fed-unlink-nopass@example.com' },
        ])) as UserDocument[];
        user.status = crowi.model('User').STATUS_ACTIVE;
        await user.save();
        await crowi.model('UserIdentity').deleteMany({ provider: 'fed-unlink-np', providerUserId: 'sub-np' });
        await crowi.model('UserIdentity').create({ userId: user._id, provider: 'fed-unlink-np', providerUserId: 'sub-np' });

        const res = await request(app)
          .delete('/api/auth/providers/fed-unlink-np/identity')
          .set('authorization', `Bearer ${webTokenFor(user)}`);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('PASSWORD_REQUIRED');
        expect(await crowi.model('UserIdentity').countDocuments({ userId: user._id, provider: 'fed-unlink-np' })).toBe(1);
      });

      it('401s without a JWT', async () => {
        const res = await request(app).delete('/api/auth/providers/fed-unlink/identity');
        expect(res.status).toBe(401);
      });
    });

    // RFC-0014 phase 4 (AC-7) — the settings screen needs to know which
    // providers the CURRENT user has connected, which nothing in phase 3
    // exposed. Slugs only: the section decides Link vs Unlink from this
    // and has no business learning the provider-side account id.
    describe('GET /api/auth/providers/identities', () => {
      it("returns the caller's own provider slugs in name order, and nothing else", async () => {
        const { user, token } = await seedWebUser('fed-list-own@example.com', 'fed-list-own');
        await seedResolvedIdentity(user, 'zeta-provider', 'sub-zeta');
        await seedResolvedIdentity(user, 'alpha-provider', 'sub-alpha');

        const res = await request(app).get('/api/auth/providers/identities').set('authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.identities).toEqual([{ provider: 'alpha-provider' }, { provider: 'zeta-provider' }]);
      });

      it("never reports another user's identity", async () => {
        const { token } = await seedWebUser('fed-list-self@example.com', 'fed-list-self');
        const other = await seedActiveUser('fed-list-other@example.com', 'fed-list-other');
        await seedResolvedIdentity(other, 'fed-list-leak', 'sub-other');

        const res = await request(app).get('/api/auth/providers/identities').set('authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.identities).toEqual([]);
      });

      it('401s without a JWT — the linked set is not public', async () => {
        const res = await request(app).get('/api/auth/providers/identities');
        expect(res.status).toBe(401);
      });

      // `identities` sits where `:name` does in the sibling routes; a
      // greedy param would swallow it and answer with a provider start.
      it('is not shadowed by the public provider routes', async () => {
        const res = await request(app).get('/api/auth/providers/identities');
        expect(res.headers.location).toBeUndefined();
      });
    });

    describe('AC-7: the handoff identity fence', () => {
      it('refuses to mint tokens when the identity was unlinked between the callback and the exchange — same generic error, no token', async () => {
        const user = await seedActiveUser('fed-fence@example.com', 'fed-fence');
        await seedResolvedIdentity(user, 'fed-oauth2', 'oauth2-user-1');
        const localApp = buildLocalApp({ resolve: async () => ({ kind: 'resolved', user }) });

        const keyPair = await createSenderKeyPair();
        const startQuery = await buildStartQuery('fed-oauth2', '/dashboard', keyPair);
        const startRes = await localApp.request(`/auth/providers/fed-oauth2/start?${startQuery}`);
        const cookie = extractStateCookie({ headers: Object.fromEntries(startRes.headers.entries()) });
        const state = new URL(startRes.headers.get('location') as string).searchParams.get('state') as string;

        const restoreFetch = mockFetch(jest.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch);
        let callbackRes: Response;
        try {
          callbackRes = await localApp.request(`/auth/providers/fed-oauth2/callback?code=abc&state=${state}`, { headers: { cookie } });
        } finally {
          restoreFetch();
        }
        const code = new URL(callbackRes.headers.get('location') as string).searchParams.get('code') as string;
        expect(code).toBeTruthy();

        // The user disconnects the provider in another tab AFTER the
        // callback minted the code but BEFORE it is redeemed. `createJwtAuth`
        // knows nothing about identity membership, so only this fence stops
        // the code from still yielding a full session.
        await crowi.model('UserIdentity').deleteMany({ userId: user._id, provider: 'fed-oauth2' });

        const proof = await buildHandoffProof(code, keyPair);
        const handoffRes = await localApp.request('/auth/handoff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, proof }),
        });

        expect(handoffRes.status).toBe(401);
        const body = (await handoffRes.json()) as { error: { code: string }; accessToken?: string };
        // Deliberately the SAME generic code as every other handoff failure
        // — a distinct one would confirm the code was otherwise valid.
        expect(body.error.code).toBe('FEDERATED_HANDOFF_INVALID');
        expect(body.accessToken).toBeUndefined();
      });
    });
  });
});
