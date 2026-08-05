import crypto from 'node:crypto';
import type { FederatedProfileTerminal } from 'src/auth/federated-profile-terminal';
import { createHonoApp } from 'src/hono/app';
import { buildProviderRedirect, completeFederatedCallback, registerFederatedAuthRoutes } from 'src/hono/handlers/federated-auth';
import type { UserDocument } from 'src/models/user';
import { app, crowi } from 'src/test/setup';
import { buildHandoffCanonicalMessage, buildStartCanonicalMessage } from 'src/util/federated-auth-state';
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

    test('the default (Phase 1) terminal declines with registration_unavailable and performs no User/UserIdentity write (AC-5)', async () => {
      oidcMock.authorizationCodeGrant.mockResolvedValueOnce({ claims: () => ({ sub: 'brand-new-user', email: 'brand-new@example.com' }) });
      const { cookie, state } = await startFlow('fed-oidc');

      const User = crowi.model('User');
      const before = await User.countDocuments({ email: 'brand-new@example.com' });
      expect(before).toBe(0);

      const res = await request(app).get(`/api/auth/providers/fed-oidc/callback?code=abc&state=${state}`).set('Cookie', cookie).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://web.test.example/login?error=registration_unavailable');

      const after = await User.countDocuments({ email: 'brand-new@example.com' });
      expect(after).toBe(0);
    });
  });

  describe('resolved terminal -> handoff -> POST /api/auth/handoff (AC-5, AC-6, AC-7)', () => {
    test('a terminal resolving an active user completes handoff with the same token shape as /auth/login', async () => {
      const user = await seedActiveUser('fed-handoff-resolved@example.com', 'fed-handoff-resolved');
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
          issue: () => '',
          verify: () => null,
        },
        handoffStore: { issue: async () => '', find: async () => null, consumeVerified: async () => ({ ok: false as const, reason: 'not_found' as const }) },
        terminal: { resolve: async () => ({ kind: 'redirect_error' as const, code: 'registration_unavailable' as const }) },
        getEnabledDriver: () => null,
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
});
