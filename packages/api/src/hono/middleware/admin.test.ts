import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0010 — `createJwtAdminRequired` web-session-only boundary.
 *
 * Admin API is a web-session-only surface: `admin:*` scopes are reserved
 * (excluded from `ISSUABLE_SCOPES`), so no PAT or OAuth access token should
 * ever reach `/admin/*`, even one issued by an admin user themself. This
 * suite exercises `GET /api/admin/users` as the representative admin
 * route (broad-applied `createJwtAdminRequired`, so the same behaviour
 * covers every other `/admin/*` handler).
 */

describe('createJwtAdminRequired — authContext boundary (Hono)', () => {
  const PAT = () => crowi.model('PersonalAccessToken');

  const ADMIN_EMAIL = 'admin-boundary@example.com';
  const NON_ADMIN_EMAIL = 'non-admin-boundary@example.com';

  let adminUser: Awaited<ReturnType<typeof createTestUser>>['user'];
  let adminWebToken: string;
  let nonAdminWebToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Admin Boundary',
      username: 'admin-boundary',
      email: ADMIN_EMAIL,
      admin: true,
    });
    adminUser = admin.user;
    adminWebToken = admin.accessToken;

    const nonAdmin = await createTestUser({
      name: 'Non Admin Boundary',
      username: 'non-admin-boundary',
      email: NON_ADMIN_EMAIL,
      admin: false,
    });
    nonAdminWebToken = nonAdmin.accessToken;
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: { $in: [ADMIN_EMAIL, NON_ADMIN_EMAIL] } });
    await PAT().deleteMany({ userId: adminUser._id });
  });

  it('(a) admin + web session -> 200', async () => {
    const res = await request(app).get('/api/admin/users').set(authHeaders(adminWebToken));
    expect(res.status).toBe(200);
  });

  it('(b) admin + PAT -> 403 ADMIN_REQUIRED', async () => {
    const PersonalAccessToken = PAT();
    const { token, tokenHash } = PersonalAccessToken.generateToken();
    await PersonalAccessToken.create({
      tokenHash,
      userId: adminUser._id,
      name: 'admin-pat',
      scopes: ['read'],
    });

    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('(c) admin + OAuth access token -> 403 ADMIN_REQUIRED', async () => {
    const jwtUtil = createJwtUtil(crowi);
    const oauthToken = jwtUtil.signOauthAccessToken({ user: adminUser, scopes: ['read'], clientId: 'crowi-cli' });

    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${oauthToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('(d) non-admin + web session -> 403 ADMIN_REQUIRED (existing behaviour)', async () => {
    const res = await request(app).get('/api/admin/users').set(authHeaders(nonAdminWebToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });
});
