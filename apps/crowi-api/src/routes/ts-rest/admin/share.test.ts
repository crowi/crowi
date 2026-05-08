import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const createTestUser = async (info: { name: string; username: string; email: string; admin?: boolean }) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = !!info.admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

/**
 * Reset the share-related config keys back to defaults between tests so each
 * case starts from a known state. The test setup boots the app once; we poke
 * the config service directly rather than rebooting.
 */
const resetShareConfig = async () => {
  const configService = crowi.getConfigService();
  await configService.saveConfig('crowi', {
    'app:externalShare': false,
  });
};

describe('Routes /api/v2/admin/share (ts-rest)', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Share Admin',
      username: 'shareAdmin',
      email: 'share-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Share Normal',
      username: 'shareNormal',
      email: 'share-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  beforeEach(async () => {
    await resetShareConfig();
  });

  describe('GET /api/v2/admin/share', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/share');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/share').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 200 with externalShare=false (default) for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/share').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ externalShare: false });
    });

    it('reflects values previously written via configService', async () => {
      await crowi.getConfigService().saveConfig('crowi', {
        'app:externalShare': true,
      });

      const res = await request(app).get('/api/v2/admin/share').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ externalShare: true });
    });
  });

  describe('PUT /api/v2/admin/share', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/v2/admin/share').send({ externalShare: true });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/v2/admin/share').set(authHeaders(userToken)).send({ externalShare: true });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when externalShare is not a boolean', async () => {
      const res = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({ externalShare: 'true' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when externalShare is missing from the body', async () => {
      const res = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(400);
    });

    it('persists externalShare=true and round-trips via GET', async () => {
      const putRes = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({ externalShare: true });
      expect(putRes.status).toBe(200);
      expect(putRes.body).toEqual({ externalShare: true });

      const getRes = await request(app).get('/api/v2/admin/share').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({ externalShare: true });
    });

    it('persists externalShare=false (toggling off works)', async () => {
      // Enable first
      await crowi.getConfigService().saveConfig('crowi', { 'app:externalShare': true });

      const putRes = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({ externalShare: false });
      expect(putRes.status).toBe(200);
      expect(putRes.body).toEqual({ externalShare: false });

      const getRes = await request(app).get('/api/v2/admin/share').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({ externalShare: false });
    });

    it('does not touch unrelated keys in the crowi namespace', async () => {
      // Seed an unrelated config value first.
      await crowi.getConfigService().saveConfig('crowi', {
        'app:title': 'Custom Crowi Title',
      });

      const res = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({ externalShare: true });
      expect(res.status).toBe(200);

      const cfg = crowi.getConfig();
      expect(cfg.crowi['app:title']).toBe('Custom Crowi Title');
      expect(cfg.crowi['app:externalShare']).toBe(true);
    });

    it('PUT result is reflected in admin/app getAppSettings.externalShare too', async () => {
      // Toggle on via the share endpoint
      const putRes = await request(app).put('/api/v2/admin/share').set(authHeaders(adminToken)).send({ externalShare: true });
      expect(putRes.status).toBe(200);

      // Verify admin/app sees the same value (read-only mirror)
      const appRes = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));
      expect(appRes.status).toBe(200);
      expect(appRes.body.app.externalShare).toBe(true);
    });
  });
});
