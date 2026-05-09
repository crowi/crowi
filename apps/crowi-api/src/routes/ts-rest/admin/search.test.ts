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

describe('Routes /api/v2/admin/search (ts-rest)', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Search Admin',
      username: 'searchAdmin',
      email: 'search-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Search Normal',
      username: 'searchNormal',
      email: 'search-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  describe('GET /api/v2/admin/search', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/search');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/search').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 200 with the active driver and the registered driver list for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/search').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      // The exact list depends on which plugins the test boot loaded.
      // Assert structural shape rather than specific names so the test
      // stays stable as the implicit-default plugin set evolves.
      expect(Array.isArray(res.body.drivers)).toBe(true);
      for (const driver of res.body.drivers) {
        expect(typeof driver.driverName).toBe('string');
        expect(typeof driver.pluginName).toBe('string');
        expect(typeof driver.isActive).toBe('boolean');
        expect(typeof driver.supportsRebuild).toBe('boolean');
      }

      // Exactly one (or zero) driver may be marked active.
      const activeCount = res.body.drivers.filter((d: { isActive: boolean }) => d.isActive).length;
      expect(activeCount).toBeLessThanOrEqual(1);

      // When `active` is non-null, it must reference one of the entries
      // and that entry's isActive flag must be true. Aligns the two
      // shapes so the UI can rely on either source of truth.
      if (res.body.active !== null) {
        expect(typeof res.body.active.driverName).toBe('string');
        expect(typeof res.body.active.pluginName).toBe('string');
        expect(typeof res.body.active.supportsRebuild).toBe('boolean');
        const matching = res.body.drivers.find((d: { driverName: string }) => d.driverName === res.body.active.driverName);
        expect(matching).toBeDefined();
        expect(matching.isActive).toBe(true);
        expect(matching.supportsRebuild).toBe(res.body.active.supportsRebuild);
      }
    });
  });
});
