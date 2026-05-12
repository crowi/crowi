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

describe('Routes /api/v2/admin/storage (ts-rest)', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Storage Admin',
      username: 'storageAdmin',
      email: 'storage-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Storage Normal',
      username: 'storageNormal',
      email: 'storage-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  describe('GET /api/v2/admin/storage', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/storage');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/storage').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 200 with the active driver and the registered driver list for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/storage').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      // The exact list depends on which plugins the test boot loaded
      // (default: @crowi/plugin-storage-local). Assert structural shape
      // rather than specific names so the test stays stable as the
      // implicit-default plugin set evolves.
      expect(Array.isArray(res.body.drivers)).toBe(true);
      for (const driver of res.body.drivers) {
        expect(typeof driver.driverName).toBe('string');
        expect(typeof driver.pluginName).toBe('string');
        expect(typeof driver.isActive).toBe('boolean');
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
        const matching = res.body.drivers.find((d: { driverName: string }) => d.driverName === res.body.active.driverName);
        expect(matching).toBeDefined();
        expect(matching.isActive).toBe(true);
      }
    });

    it('includes the implicit-default local driver in the list', async () => {
      const res = await request(app).get('/api/v2/admin/storage').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      // `@crowi/plugin-storage-local` is in IMPLICIT_DEFAULT_PLUGINS so
      // it always registers at least the `local` driver.
      const localEntry = res.body.drivers.find((d: { driverName: string }) => d.driverName === 'local');
      expect(localEntry).toBeDefined();
      expect(localEntry.pluginName).toBe('@crowi/plugin-storage-local');
    });
  });
});
