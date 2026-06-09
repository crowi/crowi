import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const createUser = async (info: { name: string; username: string; email: string }, admin = false) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

/**
 * Reload the in-memory config cache so the GET path observes the rows the test
 * just wrote directly via the model.
 */
const reloadConfigCache = async () => {
  await crowi.getConfigService().load();
};

/**
 * Tests for the slimmed-down /admin/app contract. Storage credentials
 * (AWS S3 region / bucket / accessKeyId / secretAccessKey) used to be
 * editable here; they moved to the per-plugin settings page and the
 * `upload` field is now intentionally absent from both GET responses
 * and PUT requests. These tests verify that:
 *   1. GET no longer surfaces an `upload` field.
 *   2. PUT with a stale client sending `upload` is rejected with 400.
 *   3. The remaining `app:*` keys still round-trip.
 */
describe('Routes /api/v2/admin/app (Hono, post-storage-extraction)', () => {
  let Config;
  let adminToken: string;
  let memberToken: string;

  // Keys this suite touches. Used by the per-test cleanup so each test
  // starts from a clean slate even when one test seeds and the next
  // reads.
  const APP_KEYS = ['app:title', 'app:confidential'];

  beforeAll(async () => {
    Config = crowi.model('Config');

    const admin = await createUser({ name: 'AppSettings Admin', username: 'appSettingsAdmin', email: 'app-settings-admin@example.com' }, true);
    adminToken = admin.accessToken;
    const member = await createUser({ name: 'AppSettings Member', username: 'appSettingsMember', email: 'app-settings-member@example.com' }, false);
    memberToken = member.accessToken;
  });

  afterEach(async () => {
    await Config.deleteMany({ ns: 'crowi', key: { $in: APP_KEYS } });
    await reloadConfigCache();
  });

  describe('GET /api/v2/admin/app', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/app');
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/app').set(authHeaders(memberToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the current app section without the legacy upload field', async () => {
      await Config.updateConfig('crowi', 'app:title', 'My Wiki');
      await Config.updateConfig('crowi', 'app:confidential', 'For employees only');
      await reloadConfigCache();

      const res = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.app).toEqual({
        title: 'My Wiki',
        confidential: 'For employees only',
      });
      // The pre-extraction shape included `upload.aws.*`. Asserting the
      // absence keeps the contract regression-proof.
      expect(res.body.upload).toBeUndefined();
      expect(typeof res.body.isUploadable).toBe('boolean');
      expect(res.body.registrationMode).toEqual(expect.objectContaining({ Open: 'open' }));
    });
  });

  describe('PUT /api/v2/admin/app', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .send({ app: { title: 'x' } });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(memberToken))
        .send({ app: { title: 'x' } });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('persists app section and round-trips via GET', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ app: { title: 'Round Trip Wiki', confidential: 'Internal' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const get = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));
      expect(get.status).toBe(200);
      expect(get.body.app).toEqual(expect.objectContaining({ title: 'Round Trip Wiki', confidential: 'Internal' }));
    });

    it('rejects empty title with 400', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ app: { title: '' } });
      expect(res.status).toBe(400);
    });

    it('rejects a stale client sending upload.aws.* with 400 (strict body schema)', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ upload: { aws: { region: 'us-east-1', bucket: 'x' } } });

      // Zod `strict()` on the request body rejects unknown top-level
      // keys with a per-field 400 — the contract's way of advertising
      // that storage credentials moved to /admin/plugins.
      expect(res.status).toBe(400);
    });

    it('accepts an empty body and is a no-op', async () => {
      const before = await Config.countDocuments({ ns: 'crowi' }).exec();
      const res = await request(app).put('/api/v2/admin/app').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const after = await Config.countDocuments({ ns: 'crowi' }).exec();
      expect(after).toBe(before);
    });
  });
});
