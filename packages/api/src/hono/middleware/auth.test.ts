import { Hono } from 'hono';

import { crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

import { createJwtAuth } from './auth';
import { createJwtAdminRequired } from './admin';
import { honoOnError } from './error-handler';

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
