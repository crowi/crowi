import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';
import type { UserDocument } from 'src/models/user';

import { makePluginRouterScope } from 'src/plugin/registries';
import { crowi, app as prodApp } from 'src/test/setup';
import { authHeaders, cookieAuthHeaders, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

import { createHonoApp } from '../app';
import { createJwtAdminRequired } from './admin';
import { AUTH_REQUIRED_BODY, createAuthDeps, createJwtAuth, HEADER_TOKEN_KINDS_STANDARD, resolveCredential } from './auth';
import { honoOnError } from './error-handler';

/**
 * Mint an ALREADY-EXPIRED `access` JWT directly with `jsonwebtoken`, using
 * the exact same secret-resolution formula `createJwtUtil` uses
 * (`packages/api/src/util/jwt.ts`). `generateTokens`'s TTL is a
 * module-level constant read once from `process.env` at import time, so it
 * cannot be overridden per-test — this is the only way to get a genuinely
 * expired (not merely malformed) token for the AC-1 regression below.
 * Test-only; production code never constructs a token this way.
 */
const signExpiredAccessToken = (u: Pick<UserDocument, 'email' | 'authVersion'> & { _id: { toString(): string } }): string => {
  const config = crowi.getConfig();
  const secret: string = config.crowi['app:secret'] || config.crowi['SECRET_TOKEN'] || 'your-secret-key';
  return jwt.sign({ userId: u._id.toString(), email: u.email, type: 'access', av: u.authVersion ?? 0 }, secret, { expiresIn: -10, issuer: 'crowi' });
};

/**
 * Regression: `jwtAuth` must NOT mask a downstream handler / infra error as
 * 401. Previously its `try { … await next() } catch { 401 }` wrapped `next()`,
 * so ANY throw from an authenticated handler surfaced as a spurious
 * `AUTHENTICATION_REQUIRED` 401 — hiding real 500s from clients and logs (and
 * amplifying flaky failures into misleading auth errors). A genuine
 * authentication failure is still an explicit 401/403; a throw is infra/handler
 * and must reach `onError` (500). This also covers the nested
 * `createJwtAdminRequired` composition, which is where the bug was observed.
 */
describe('jwtAuth — does not mask handler/infra errors as 401', () => {
  const USER_EMAIL = 'auth-mask-user@example.com';
  const ADMIN_EMAIL = 'auth-mask-admin@example.com';

  let webToken: string;
  let adminToken: string;
  let app: Hono;

  beforeAll(async () => {
    const u = await createTestUser({ name: 'Auth Mask User', username: 'auth-mask-user', email: USER_EMAIL, admin: false });
    webToken = u.accessToken;
    const a = await createTestUser({ name: 'Auth Mask Admin', username: 'auth-mask-admin', email: ADMIN_EMAIL, admin: true });
    adminToken = a.accessToken;

    app = new Hono();
    app.onError(honoOnError);

    // Plain authenticated routes.
    app.use('/plain/*', createJwtAuth(crowi));
    app.get('/plain/throw', () => {
      throw new Error('handler boom');
    });
    app.get('/plain/ok', (c) => c.json({ ok: true }));

    // Admin composition (nested jwtAuth) — the observed failure site.
    app.use('/admin/*', createJwtAdminRequired(crowi));
    app.get('/admin/throw', () => {
      throw new Error('admin handler boom');
    });
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: { $in: [USER_EMAIL, ADMIN_EMAIL] } });
  });

  it('handler throw under jwtAuth surfaces as 500, not 401', async () => {
    const res = await app.request('/plain/throw', { headers: authHeaders(webToken) });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL_ERROR');
  });

  it('handler throw under createJwtAdminRequired surfaces as 500, not 401', async () => {
    const res = await app.request('/admin/throw', { headers: authHeaders(adminToken) });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL_ERROR');
  });

  it('an infra throw resolving the principal (findById) surfaces as 500 and never runs the handler (fail-closed)', async () => {
    const User = crowi.model('User');
    const spy = jest.spyOn(User, 'findById').mockImplementationOnce((() => Promise.reject(new Error('db unreachable'))) as never);

    let handlerReached = false;
    const app2 = new Hono();
    app2.onError(honoOnError);
    app2.use('/x/*', createJwtAuth(crowi));
    app2.get('/x/ok', (c) => {
      handlerReached = true;
      return c.json({ ok: true });
    });

    const res = await app2.request('/x/ok', { headers: authHeaders(webToken) });
    expect(res.status).toBe(500);
    expect(handlerReached).toBe(false);
    spy.mockRestore();
  });

  it('still returns 401 when no token is presented (auth failure unchanged)', async () => {
    const res = await app.request('/plain/ok');
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('still returns 401 for an invalid token (auth failure unchanged)', async () => {
    const res = await app.request('/plain/ok', { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('still returns 403 ADMIN_REQUIRED for a non-admin web session (short-circuit preserved)', async () => {
    const res = await app.request('/admin/throw', { headers: authHeaders(webToken) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('ADMIN_REQUIRED');
  });

  it('an infra throw applying scopes (PAT touchLastUsed) surfaces as 500 and never runs the handler', async () => {
    const PersonalAccessToken = crowi.model('PersonalAccessToken');
    const u = await crowi.model('User').findOne({ email: USER_EMAIL });
    // A resolved PAT whose best-effort last-used write rejects. `apply()` awaits
    // it, so before the fix this infra failure was masked as 401; it must now
    // surface as 500 and short-circuit before the handler.
    const spy = jest.spyOn(PersonalAccessToken, 'findActiveByHash').mockResolvedValueOnce({
      _id: u?._id,
      userId: u?._id,
      scopes: ['read'],
      touchLastUsed: () => Promise.reject(new Error('pat last-used write failed')),
    } as never);

    let handlerReached = false;
    const app2 = new Hono();
    app2.onError(honoOnError);
    app2.use('/y/*', createJwtAuth(crowi));
    app2.get('/y/ok', (c) => {
      handlerReached = true;
      return c.json({ ok: true });
    });

    const res = await app2.request('/y/ok', { headers: { Authorization: `Bearer ${PersonalAccessToken.TOKEN_PREFIX}apply-throw` } });
    expect(res.status).toBe(500);
    expect(handlerReached).toBe(false);
    spy.mockRestore();
  });

  it('forwards jwtAuth 401 short-circuit through createJwtAdminRequired (no / invalid token, handler not reached)', async () => {
    const noToken = await app.request('/admin/throw');
    expect(noToken.status).toBe(401);
    expect((await noToken.json()).error.code).toBe('AUTHENTICATION_REQUIRED');

    const badToken = await app.request('/admin/throw', { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(badToken.status).toBe(401);
    expect((await badToken.json()).error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

/**
 * feature-auth-cookie-fallback-scope — AC-1/AC-2/AC-3 regression suite.
 *
 * `/cookie-eligible/*` below is a synthetic route built directly on
 * `resolveCredential` with `cookieEligible: true` (the same shape
 * `createAttachmentAuth` uses for its three delivery routes) so AC-1/AC-2
 * can assert the credential-resolution core's cookie-vs-header precedence
 * and provenance directly, independent of any one real route's policy.
 * AC-3 then confirms the header-only DEFAULT (`cookieEligible: false`)
 * really is what `createJwtAuth`'s real consumers — admin, `/pages/*`, and
 * the plugin `auth: 'user'` default — get.
 */
describe('feature-auth-cookie-fallback-scope — cookie fallback scope', () => {
  const USER_EMAIL = 'cookie-scope-user@example.com';
  const OTHER_EMAIL = 'cookie-scope-other@example.com';
  const SUSPENDED_EMAIL = 'cookie-scope-suspended@example.com';
  const ADMIN_EMAIL = 'cookie-scope-admin@example.com';

  let user: Awaited<ReturnType<typeof createTestUser>>['user'];
  let accessToken: string;
  let otherAccessToken: string;
  let app: Hono;
  let jwtUtil: ReturnType<typeof createJwtUtil>;

  beforeAll(async () => {
    jwtUtil = createJwtUtil(crowi);

    const u = await createTestUser({ name: 'Cookie Scope User', username: 'cookieScopeUser', email: USER_EMAIL });
    user = u.user;
    accessToken = u.accessToken;

    const o = await createTestUser({ name: 'Cookie Scope Other', username: 'cookieScopeOther', email: OTHER_EMAIL });
    otherAccessToken = o.accessToken;

    app = new Hono();
    app.onError(honoOnError);

    // `createJwtAuth`'s real (header-only) default.
    app.use('/plain/*', createJwtAuth(crowi));
    app.get('/plain/ok', (c) => c.json({ ok: true }));

    // Direct `resolveCredential` with `cookieEligible: true` — mirrors
    // `createAttachmentAuth`'s delivery-route policy without depending on
    // attachment routing/paths.
    const deps = createAuthDeps(crowi);
    app.use(
      '/cookie-eligible/*',
      createMiddleware(async (c, next) => {
        const result = await resolveCredential(c, deps, { cookieEligible: true, headerTokenKinds: HEADER_TOKEN_KINDS_STANDARD });
        if (!result.ok) {
          return c.json(result.status === 401 ? AUTH_REQUIRED_BODY : result.body, result.status);
        }
        await next();
      }),
    );
    app.get('/cookie-eligible/ok', (c) =>
      c.json({ authContext: c.get('authContext'), userId: (c.get('user') as { _id: { toString(): string } })._id.toString() }),
    );
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: { $in: [USER_EMAIL, OTHER_EMAIL, SUSPENDED_EMAIL, ADMIN_EMAIL] } });
  });

  describe('AC-1 — a present Authorization header never falls back to the cookie', () => {
    it.each([
      ['an empty string', ''],
      ['garbage', 'garbage'],
      ['Bearer with no token', 'Bearer'],
      ['an unsupported scheme (Basic)', 'Basic dXNlcjpwYXNz'],
    ])('rejects %s Authorization header even with a valid cookie present', async (_label, headerValue) => {
      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: headerValue, ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed/unparseable Bearer with a valid cookie present', async () => {
      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: 'Bearer not-a-real-token', ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(401);
    });

    it('rejects an actual expired access JWT Bearer with a valid cookie present', async () => {
      const expired = signExpiredAccessToken(user);
      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: `Bearer ${expired}`, ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(401);
    });

    it('rejects a refresh-type JWT (not an access token) Bearer with a valid cookie present', async () => {
      const refreshToken = jwtUtil.generateTokens(user).refreshToken;
      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: `Bearer ${refreshToken}`, ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown PAT Bearer with a valid cookie present', async () => {
      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const res = await app.request('/cookie-eligible/ok', {
        headers: { Authorization: `Bearer ${PersonalAccessToken.TOKEN_PREFIX}nonexistent`, ...cookieAuthHeaders(accessToken) },
      });
      expect(res.status).toBe(401);
    });

    it('rejects an actually-revoked PAT Bearer with a valid cookie present', async () => {
      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'cookie-scope-pat-revoked', scopes: ['pages:read'], revokedAt: new Date() });

      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: `Bearer ${token}`, ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(401);
    });

    it('accepts the cookie only when the Authorization field is genuinely absent', async () => {
      const res = await app.request('/cookie-eligible/ok', { headers: { ...cookieAuthHeaders(accessToken) } });
      expect(res.status).toBe(200);
    });
  });

  describe('AC-2 — resolve policy provenance, cookie PAT/OAuth rejection, header priority, PAT lastUsedAt', () => {
    it('records via: "header" for a header-authenticated web session', async () => {
      const res = await app.request('/cookie-eligible/ok', { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authContext: { kind: string; via?: string } };
      expect(body.authContext).toEqual({ kind: 'web', via: 'header' });
    });

    it('records via: "cookie" for a cookie-authenticated web session', async () => {
      const res = await app.request('/cookie-eligible/ok', { headers: cookieAuthHeaders(accessToken) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authContext: { kind: string; via?: string } };
      expect(body.authContext).toEqual({ kind: 'web', via: 'cookie' });
    });

    it('rejects a PAT string presented as the cookie value (cookie is access-JWT-only)', async () => {
      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'cookie-scope-pat-as-cookie', scopes: ['pages:read'] });

      const res = await app.request('/cookie-eligible/ok', { headers: cookieAuthHeaders(token) });
      expect(res.status).toBe(401);
    });

    it('rejects an oauth_access token presented as the cookie value (cookie accepts access only)', async () => {
      const oauthToken = jwtUtil.signOauthAccessToken({ user, scopes: ['pages:read'], clientId: 'cookie-scope-test-client' });
      const res = await app.request('/cookie-eligible/ok', { headers: cookieAuthHeaders(oauthToken) });
      expect(res.status).toBe(401);
    });

    it('a present header takes priority over a cookie for a different user', async () => {
      const res = await app.request('/cookie-eligible/ok', {
        headers: { Authorization: `Bearer ${accessToken}`, ...cookieAuthHeaders(otherAccessToken) },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authContext: { kind: string; via?: string }; userId: string };
      expect(body.userId).toBe(user._id.toString());
      expect(body.authContext).toEqual({ kind: 'web', via: 'header' });
    });

    it('bumps lastUsedAt for an active-user PAT only after the status check passes', async () => {
      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      const created = await PersonalAccessToken.create({ tokenHash, userId: user._id, name: 'cookie-scope-pat-active', scopes: ['pages:read'] });
      expect(created.lastUsedAt).toBeNull();

      const res = await app.request('/plain/ok', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);

      const reloaded = await PersonalAccessToken.findById(created._id);
      expect(reloaded?.lastUsedAt).not.toBeNull();
    });

    it('never touches lastUsedAt for a suspended user PAT (status check runs before apply())', async () => {
      const suspended = await createTestUser({ name: 'Cookie Scope Suspended', username: 'cookieScopeSuspended', email: SUSPENDED_EMAIL });
      const User = crowi.model('User');
      suspended.user.status = User.STATUS_SUSPENDED;
      await suspended.user.save();

      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      const created = await PersonalAccessToken.create({ tokenHash, userId: suspended.user._id, name: 'cookie-scope-pat-suspended', scopes: ['pages:read'] });
      expect(created.lastUsedAt).toBeNull();

      const res = await app.request('/plain/ok', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('USER_SUSPENDED');

      const reloaded = await PersonalAccessToken.findById(created._id);
      expect(reloaded?.lastUsedAt).toBeNull();
    });
  });

  describe('AC-3 — real createJwtAuth consumers stay header-only', () => {
    it('rejects a headerless cookie on an admin route (GET /api/admin/app) and accepts a valid Bearer', async () => {
      const admin = await createTestUser({ name: 'Cookie Scope Admin', username: 'cookieScopeAdmin', email: ADMIN_EMAIL, admin: true });

      const cookieRes = await request(prodApp).get('/api/admin/app').set(cookieAuthHeaders(admin.accessToken));
      expect(cookieRes.status).toBe(401);

      const headerRes = await request(prodApp).get('/api/admin/app').set(authHeaders(admin.accessToken));
      expect(headerRes.status).toBe(200);
    });

    it('rejects a headerless cookie on a /pages/* route (GET /api/pages) and accepts a valid Bearer', async () => {
      const cookieRes = await request(prodApp).get('/api/pages').query({ path: '/cookie-scope-test-nonexistent' }).set(cookieAuthHeaders(accessToken));
      expect(cookieRes.status).toBe(401);

      const headerRes = await request(prodApp).get('/api/pages').query({ path: '/cookie-scope-test-nonexistent' }).set(authHeaders(accessToken));
      // 404 (page not found) still proves the request authenticated and reached the handler.
      expect(headerRes.status).toBe(404);
    });

    it("rejects a headerless cookie on the plugin auth: 'user' default and accepts a valid Bearer", async () => {
      const pluginApp = createHonoApp();
      const scope = makePluginRouterScope(pluginApp, crowi, 'cookie-scope-test-plugin');
      scope.route('GET', '/probe', (c) => c.json({ ok: true }));

      const cookieRes = await pluginApp.request('/plugins/cookie-scope-test-plugin/probe', { headers: { Cookie: `crowi.accessToken=${accessToken}` } });
      expect(cookieRes.status).toBe(401);

      const headerRes = await pluginApp.request('/plugins/cookie-scope-test-plugin/probe', { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(headerRes.status).toBe(200);
    });
  });
});
