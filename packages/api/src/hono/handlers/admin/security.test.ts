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
 * Reset the registration-related security:* keys back to defaults between
 * tests so each case starts from a known state. We can't simply rely on
 * `applicationInstall` because the test setup boots the app once; instead we
 * directly poke the config service / collection.
 */
const resetSecurityConfig = async () => {
  const configService = crowi.getConfigService();
  await configService.saveConfig('crowi', {
    'security:registrationMode': 'Open',
    'security:registrationWhiteList': [],
  });
};

describe('Routes /api/v2/admin/security (Hono)', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Security Admin',
      username: 'securityAdmin',
      email: 'security-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Security Normal',
      username: 'securityNormal',
      email: 'security-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  beforeEach(async () => {
    await resetSecurityConfig();
  });

  describe('GET /api/v2/admin/security', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/security');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/security').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the current security:* settings for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/security').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Open',
        registrationWhiteList: [],
      });
    });

    it('reflects values previously written via configService', async () => {
      await crowi.getConfigService().saveConfig('crowi', {
        'security:registrationMode': 'Resricted',
        'security:registrationWhiteList': ['allowed@example.com', 'team@example.org'],
      });

      const res = await request(app).get('/api/v2/admin/security').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Resricted',
        registrationWhiteList: ['allowed@example.com', 'team@example.org'],
      });
    });
  });

  describe('PUT /api/v2/admin/security', () => {
    const validBody = {
      registrationMode: 'Closed' as const,
      registrationWhiteList: ['user@example.com'],
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/v2/admin/security').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/v2/admin/security').set(authHeaders(userToken)).send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when registrationMode is outside the enum', async () => {
      const res = await request(app)
        .put('/api/v2/admin/security')
        .set(authHeaders(adminToken))
        .send({
          ...validBody,
          registrationMode: 'Restricted', // correct spelling - intentionally rejected
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when registrationWhiteList is not an array', async () => {
      const res = await request(app)
        .put('/api/v2/admin/security')
        .set(authHeaders(adminToken))
        .send({
          ...validBody,
          registrationWhiteList: 'allowed@example.com',
        });
      expect(res.status).toBe(400);
    });

    it('persists the registration security:* keys and returns the updated settings', async () => {
      const res = await request(app)
        .put('/api/v2/admin/security')
        .set(authHeaders(adminToken))
        .send({
          registrationMode: 'Resricted',
          registrationWhiteList: ['user@example.com'],
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Resricted',
        registrationWhiteList: ['user@example.com'],
      });

      // Round-trip via GET to verify the in-memory cache and the persisted
      // values are in sync.
      const getRes = await request(app).get('/api/v2/admin/security').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.registrationMode).toBe('Resricted');
      expect(getRes.body.registrationWhiteList).toEqual(['user@example.com']);
    });

    it('trims whitespace and drops empty entries from registrationWhiteList', async () => {
      const res = await request(app)
        .put('/api/v2/admin/security')
        .set(authHeaders(adminToken))
        .send({
          registrationMode: 'Resricted',
          registrationWhiteList: ['  user@example.com  ', '', '   ', 'team@example.org'],
        });

      expect(res.status).toBe(200);
      expect(res.body.registrationWhiteList).toEqual(['user@example.com', 'team@example.org']);
    });

    it('does not touch unrelated keys in the crowi namespace', async () => {
      // Seed an unrelated config value first.
      await crowi.getConfigService().saveConfig('crowi', {
        'app:title': 'Custom Crowi Title',
      });

      const res = await request(app).put('/api/v2/admin/security').set(authHeaders(adminToken)).send(validBody);
      expect(res.status).toBe(200);

      const cfg = crowi.getConfig();
      expect(cfg.crowi['app:title']).toBe('Custom Crowi Title');
      expect(cfg.crowi['security:registrationMode']).toBe('Closed');
    });
  });
});
