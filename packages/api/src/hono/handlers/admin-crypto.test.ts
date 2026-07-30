import crypto from 'crypto';
import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { authHeaders } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import { isEncrypted, resetKeyProvider } from 'src/util/crypto';

const createUser = async (info: { name: string; username: string; email: string }, admin = false) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

describe('Routes /api/admin/crypto (Hono)', () => {
  let Config;
  let adminToken: string;
  let memberToken: string;
  const originalKey = process.env.CROWI_ENCRYPTION_KEY;

  beforeAll(async () => {
    Config = crowi.model('Config');
    process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    resetKeyProvider();

    const admin = await createUser({ name: 'Crypto Admin', username: 'cryptoAdmin', email: 'crypto-admin@example.com' }, true);
    adminToken = admin.accessToken;
    const member = await createUser({ name: 'Crypto Member', username: 'cryptoMember', email: 'crypto-member@example.com' }, false);
    memberToken = member.accessToken;
  });

  afterEach(async () => {
    // Drop the rows the tests inserted so each test starts from a clean slate.
    await Config.deleteMany({
      $or: [
        { ns: 'notification', key: 'slack:clientSecret' },
        { ns: 'notification', key: 'slack:token' },
      ],
    });
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.CROWI_ENCRYPTION_KEY;
    } else {
      process.env.CROWI_ENCRYPTION_KEY = originalKey;
    }
    resetKeyProvider();
  });

  describe('GET /api/admin/crypto/status', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/admin/crypto/status');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      const res = await request(app).get('/api/admin/crypto/status').set(authHeaders(memberToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('reports plaintext + encrypted counts and the per-entry status', async () => {
      // Seed: one plaintext (legacy) sensitive value and one already-encrypted via updateConfig.
      await Config.findOneAndUpdate(
        { ns: 'notification', key: 'slack:clientSecret' },
        { ns: 'notification', key: 'slack:clientSecret', value: JSON.stringify('legacy-plain') },
        { upsert: true },
      ).exec();
      await Config.updateConfig('notification', 'slack:token', 'live-token-value');

      const res = await request(app).get('/api/admin/crypto/status').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.encryptionConfigured).toBe(true);
      expect(res.body.unencryptedCount).toBe(1);
      expect(res.body.encryptedCount).toBe(1);

      const byKey = new Map<string, { present: boolean; encrypted: boolean }>(
        (res.body.entries as Array<{ ns: string; key: string; present: boolean; encrypted: boolean }>).map((e) => [`${e.ns}:${e.key}`, e]),
      );
      expect(byKey.get('notification:slack:clientSecret')).toEqual(expect.objectContaining({ present: true, encrypted: false }));
      expect(byKey.get('notification:slack:token')).toEqual(expect.objectContaining({ present: true, encrypted: true }));
    });
  });

  describe('POST /api/admin/crypto/reencrypt', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/admin/crypto/reencrypt').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      const res = await request(app).post('/api/admin/crypto/reencrypt').set(authHeaders(memberToken)).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('rewrites plaintext sensitive rows in place and skips already-encrypted ones', async () => {
      // Plaintext (legacy) row
      await Config.findOneAndUpdate(
        { ns: 'notification', key: 'slack:clientSecret' },
        { ns: 'notification', key: 'slack:clientSecret', value: JSON.stringify('legacy-plain') },
        { upsert: true },
      ).exec();
      // Already encrypted row
      await Config.updateConfig('notification', 'slack:token', 'live-token');

      const res = await request(app).post('/api/admin/crypto/reencrypt').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(200);
      expect(res.body.rewritten).toBe(1);
      expect(res.body.alreadyEncrypted).toBe(1);
      // Other registry entries (plugin runtime-registered sensitive keys) absent → counted as missing
      expect(res.body.missing).toBeGreaterThan(0);

      // Storage check: the secret now starts with the prefix and decrypts back.
      const stored = await Config.findOne({ ns: 'notification', key: 'slack:clientSecret' }).exec();
      expect(isEncrypted(stored.value)).toBe(true);

      const config = await Config.loadAllConfig();
      expect(config.notification['slack:clientSecret']).toBe('legacy-plain');
      expect(config.notification['slack:token']).toBe('live-token');
    });

    it('returns 503 when CROWI_ENCRYPTION_KEY is not configured', async () => {
      delete process.env.CROWI_ENCRYPTION_KEY;
      resetKeyProvider();

      const res = await request(app).post('/api/admin/crypto/reencrypt').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ENCRYPTION_NOT_CONFIGURED');

      // Restore for subsequent tests
      process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
      resetKeyProvider();
    });
  });
});
