import { ARTIFACT_MAX_BYTES_MAX, ARTIFACT_MAX_BYTES_MIN } from '@crowi/api-contract';
import request from 'supertest';

import { ARTIFACT_HARD_MAX_BYTES, ARTIFACT_MIN_MAX_BYTES } from 'src/artifact/constants';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

const USABLE_SECRET = 'a-real-secret-value-for-admin-artifact-tests';

describe('AC-DP-2: contract byte-range constants match the core leaf definitions', () => {
  it('ARTIFACT_MAX_BYTES_MIN === ARTIFACT_MIN_MAX_BYTES', () => {
    expect(ARTIFACT_MAX_BYTES_MIN).toBe(ARTIFACT_MIN_MAX_BYTES);
  });

  it('ARTIFACT_MAX_BYTES_MAX === ARTIFACT_HARD_MAX_BYTES', () => {
    expect(ARTIFACT_MAX_BYTES_MAX).toBe(ARTIFACT_HARD_MAX_BYTES);
  });
});

describe('Routes /api/admin/artifact (Hono)', () => {
  let adminToken: string;
  let userToken: string;
  let configSnapshot: ConfigRow[];

  const resetArtifactConfig = async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'app:secret': USABLE_SECRET,
      'artifact:policy': { sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
    });
  };

  beforeAll(async () => {
    configSnapshot = await snapshotCrowiConfig(crowi);

    const admin = await createTestUser({
      name: 'Artifact Admin',
      username: 'artifactAdmin',
      email: 'artifact-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Artifact Normal',
      username: 'artifactNormal',
      email: 'artifact-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  beforeEach(async () => {
    await resetArtifactConfig();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/admin/artifact', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/admin/artifact');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/artifact').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the effective delivery mode and stored settings for an admin (default: disabled, R-4)', async () => {
      const res = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        deliveryMode: 'disabled',
        artifactOrigin: null,
        crowiOrigin: expect.any(String),
        writeEnabled: false,
        sameOriginInactiveReason: null,
        settings: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
      });
    });

    it('reflects a Mode A (separate-origin) snapshot via a getArtifactDeliveryEnv spy', async () => {
      jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: 'https://artifacts.example.net', crowiOrigin: 'https://wiki.example.com' });
      const res = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ deliveryMode: 'separate-origin', artifactOrigin: 'https://artifacts.example.net', writeEnabled: true });
    });
  });

  describe('PUT /api/admin/artifact', () => {
    const validBody = { sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 };

    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/admin/artifact').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/admin/artifact').set(authHeaders(userToken)).send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 for an out-of-range maxBytes', async () => {
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ ...validBody, maxBytes: ARTIFACT_MAX_BYTES_MIN - 1 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for an unknown extra key (strict schema)', async () => {
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ ...validBody, extra: 'nope' });
      expect(res.status).toBe(400);
    });

    it.each([
      ['true', true],
      ['false', false],
    ])('persists sameOriginEnabled=%s and round-trips through GET and resolveArtifactPolicySnapshot (boundary maxBytes 65536)', async (_label, sameOriginEnabled) => {
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ sameOriginEnabled, allowWebFonts: true, maxBytes: ARTIFACT_MIN_MAX_BYTES });
      expect(res.status).toBe(200);
      expect(res.body.settings).toEqual({ sameOriginEnabled, allowWebFonts: true, maxBytes: ARTIFACT_MIN_MAX_BYTES });

      const getRes = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.settings).toEqual({ sameOriginEnabled, allowWebFonts: true, maxBytes: ARTIFACT_MIN_MAX_BYTES });
    });

    it('round-trips the max boundary maxBytes (10485760)', async () => {
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ sameOriginEnabled: false, allowWebFonts: false, maxBytes: ARTIFACT_HARD_MAX_BYTES });
      expect(res.status).toBe(200);
      expect(res.body.settings.maxBytes).toBe(ARTIFACT_HARD_MAX_BYTES);
    });

    it('§A-4: sameOriginEnabled:true with no CLIENT_URL rejects with 400 ARTIFACT_SETTINGS_REJECTED, DB left unchanged', async () => {
      jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: null, crowiOrigin: null });
      const before = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));

      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: {
          code: 'ARTIFACT_SETTINGS_REJECTED',
          reason: 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN',
          message: expect.any(String),
        },
      });

      const after = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
      expect(after.body.settings).toEqual(before.body.settings);
    });

    it('§A-4: sameOriginEnabled:false with no CLIENT_URL is never rejected (disabling is always allowed)', async () => {
      jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: null, crowiOrigin: null });
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
      expect(res.status).toBe(200);
    });

    it('Mode A active: sameOriginEnabled:true is accepted and saved (stored but inactive, R-1 wins)', async () => {
      jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: 'https://artifacts.example.net', crowiOrigin: 'https://wiki.example.com' });
      const res = await request(app)
        .put('/api/admin/artifact')
        .set(authHeaders(adminToken))
        .send({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
      expect(res.status).toBe(200);
      expect(res.body.deliveryMode).toBe('separate-origin');
      expect(res.body.sameOriginInactiveReason).toBe('separate-origin-active');

      const getRes = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
      expect(getRes.body.deliveryMode).toBe('separate-origin');
      expect(getRes.body.sameOriginInactiveReason).toBe('separate-origin-active');
      expect(getRes.body.settings.sameOriginEnabled).toBe(true);
    });

    describe('write failure semantics (§契約 Transaction/concurrency)', () => {
      it('a write rejected before persisting 500s, leaving GET and the Config row on the old object', async () => {
        const Config = crowi.model('Config');
        jest.spyOn(Config, 'updateConfigByNamespace').mockRejectedValueOnce(new Error('mongo write failed'));

        const before = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));

        const res = await request(app)
          .put('/api/admin/artifact')
          .set(authHeaders(adminToken))
          .send({ sameOriginEnabled: false, allowWebFonts: true, maxBytes: 5 * 1024 * 1024 });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');

        const after = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
        expect(after.body.settings).toEqual(before.body.settings);

        const row = await Config.findOne({ ns: 'crowi', key: 'artifact:policy' }).lean().exec();
        expect(JSON.parse((row as { value: string }).value)).toEqual(before.body.settings);
      });

      it('a commit that succeeds but whose post-write notify throws still 500s, but GET returns the NEW object in full (no partial mix)', async () => {
        jest.spyOn(crowi, 'setupMailer').mockRejectedValueOnce(new Error('post-write notify failed'));

        const newSettings = { sameOriginEnabled: false, allowWebFonts: true, maxBytes: 7 * 1024 * 1024 };
        const res = await request(app).put('/api/admin/artifact').set(authHeaders(adminToken)).send(newSettings);
        expect(res.status).toBe(500);

        const getRes = await request(app).get('/api/admin/artifact').set(authHeaders(adminToken));
        expect(getRes.status).toBe(200);
        expect(getRes.body.settings).toEqual(newSettings);
      });
    });
  });
});
