import crypto from 'crypto';
import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';
import { isEncrypted, resetKeyProvider } from 'src/util/crypto';

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
 * just wrote directly via the model. Production updates go through
 * configService.saveConfig which keeps the cache in sync; tests that bypass
 * that path (e.g. `Config.findOneAndUpdate`) must call this helper before
 * asserting on the API response.
 */
const reloadConfigCache = async () => {
  await crowi.getConfigService().load();
};

describe('Routes /api/v2/admin/app (ts-rest)', () => {
  let Config;
  let adminToken: string;
  let memberToken: string;
  const originalKey = process.env.CROWI_ENCRYPTION_KEY;

  // Keys this suite touches. Used by the per-test cleanup so each test starts
  // from a clean slate even when one test seeds and the next reads.
  const APP_KEYS = ['app:title', 'app:confidential', 'app:fileUpload', 'app:externalShare'];
  const AWS_KEYS = ['upload:aws:region', 'upload:aws:bucket', 'upload:aws:accessKeyId', 'upload:aws:secretAccessKey'];

  beforeAll(async () => {
    Config = crowi.model('Config');
    process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    resetKeyProvider();

    const admin = await createUser({ name: 'AppSettings Admin', username: 'appSettingsAdmin', email: 'app-settings-admin@example.com' }, true);
    adminToken = admin.accessToken;
    const member = await createUser({ name: 'AppSettings Member', username: 'appSettingsMember', email: 'app-settings-member@example.com' }, false);
    memberToken = member.accessToken;
  });

  afterEach(async () => {
    await Config.deleteMany({
      ns: 'crowi',
      key: { $in: [...APP_KEYS, ...AWS_KEYS] },
    });
    await reloadConfigCache();
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.CROWI_ENCRYPTION_KEY;
    } else {
      process.env.CROWI_ENCRYPTION_KEY = originalKey;
    }
    resetKeyProvider();
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

    it('returns the current app + upload sections with secret masking', async () => {
      // Seed via the model so we can verify the GET path reads what is stored.
      // Going through updateConfig keeps sensitive auto-encryption identical to
      // the real save path.
      await Config.updateConfig('crowi', 'app:title', 'My Wiki');
      await Config.updateConfig('crowi', 'app:confidential', 'For employees only');
      await Config.updateConfig('crowi', 'app:fileUpload', true);
      await Config.updateConfig('crowi', 'upload:aws:region', 'ap-northeast-1');
      await Config.updateConfig('crowi', 'upload:aws:bucket', 'my-bucket');
      await Config.updateConfig('crowi', 'upload:aws:accessKeyId', 'AKIAFAKE');
      await Config.updateConfig('crowi', 'upload:aws:secretAccessKey', 'super-secret');
      await reloadConfigCache();

      const res = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.app).toEqual({
        title: 'My Wiki',
        confidential: 'For employees only',
        fileUpload: true,
        externalShare: false,
      });
      expect(res.body.upload.aws).toEqual({
        region: 'ap-northeast-1',
        bucket: 'my-bucket',
        accessKeyId: 'AKIAFAKE',
        secretAccessKey: { hasValue: true },
      });
      // Plaintext must never be exposed by the API, even via JSON.stringify of
      // a nested object.
      expect(JSON.stringify(res.body)).not.toContain('super-secret');
      expect(typeof res.body.isUploadable).toBe('boolean');
      expect(res.body.registrationMode).toEqual(expect.objectContaining({ Open: 'open' }));
    });

    it('reports hasValue=false when the secret is empty', async () => {
      await Config.updateConfig('crowi', 'upload:aws:secretAccessKey', '');
      await reloadConfigCache();

      const res = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.upload.aws.secretAccessKey).toEqual({ hasValue: false });
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

    it('persists app + upload sections and round-trips via GET', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({
          app: { title: 'Round Trip Wiki', confidential: 'Internal', fileUpload: true },
          upload: {
            aws: {
              region: 'us-east-1',
              bucket: 'rt-bucket',
              accessKeyId: 'AKIA12345',
              secretAccessKey: 'rt-secret-value',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const get = await request(app).get('/api/v2/admin/app').set(authHeaders(adminToken));
      expect(get.status).toBe(200);
      expect(get.body.app).toEqual(expect.objectContaining({ title: 'Round Trip Wiki', confidential: 'Internal', fileUpload: true }));
      expect(get.body.upload.aws).toEqual({
        region: 'us-east-1',
        bucket: 'rt-bucket',
        accessKeyId: 'AKIA12345',
        secretAccessKey: { hasValue: true },
      });
    });

    it('rejects empty title with 400', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ app: { title: '' } });
      expect(res.status).toBe(400);
    });

    it('rejects invalid AWS region with 400', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ upload: { aws: { region: 'not a region' } } });
      expect(res.status).toBe(400);
    });

    it('leaves the secret untouched when secretAccessKey is omitted', async () => {
      // Seed an existing secret.
      await Config.updateConfig('crowi', 'upload:aws:secretAccessKey', 'pre-existing');
      await reloadConfigCache();

      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ upload: { aws: { region: 'ap-northeast-1' } } });

      expect(res.status).toBe(200);

      // The secret column should still hold the original value (encrypted at
      // rest).
      const stored = await Config.findOne({ ns: 'crowi', key: 'upload:aws:secretAccessKey' }).exec();
      expect(stored).not.toBeNull();
      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['upload:aws:secretAccessKey']).toBe('pre-existing');
    });

    it('clears the secret when secretAccessKey is empty string', async () => {
      await Config.updateConfig('crowi', 'upload:aws:secretAccessKey', 'will-be-cleared');
      await reloadConfigCache();

      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({ upload: { aws: { secretAccessKey: '' } } });

      expect(res.status).toBe(200);

      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['upload:aws:secretAccessKey']).toBe('');
    });

    it('encrypts the secret at rest (enc:v1: prefix) when CROWI_ENCRYPTION_KEY is set', async () => {
      const res = await request(app)
        .put('/api/v2/admin/app')
        .set(authHeaders(adminToken))
        .send({
          app: { title: 'Encryption Check' },
          upload: { aws: { secretAccessKey: 'plaintext-secret-value' } },
        });
      expect(res.status).toBe(200);

      const stored = await Config.findOne({ ns: 'crowi', key: 'upload:aws:secretAccessKey' }).exec();
      expect(stored).not.toBeNull();
      expect(isEncrypted(stored.value)).toBe(true);
      // Plaintext check on the raw stored column for paranoia.
      expect(stored.value).not.toContain('plaintext-secret-value');

      // loadAllConfig decrypts transparently.
      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['upload:aws:secretAccessKey']).toBe('plaintext-secret-value');
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
