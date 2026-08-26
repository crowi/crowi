import request from 'supertest';
import { app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

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
  await configService.saveConfigValue('crowi', 'security:linkCardEnabled', true);
};

describe('Routes /api/admin/security (Hono)', () => {
  let adminToken: string;
  let userToken: string;
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    // These tests mutate the shared `security:*` registration config via
    // saveConfig. Snapshot the namespace up front so afterAll restores the
    // exact as-discovered (installed) state — a concurrent worker reading
    // registration/security config while this file has it mutated must not see
    // a transient value leak across files.
    configSnapshot = await snapshotCrowiConfig(crowi);

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

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  beforeEach(async () => {
    await resetSecurityConfig();
  });

  describe('GET /api/admin/security', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/admin/security');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/security').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the current security:* settings for an admin', async () => {
      const res = await request(app).get('/api/admin/security').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Open',
        registrationWhiteList: [],
        linkCardEnabled: true,
      });
    });

    it('reflects values previously written via configService', async () => {
      await crowi.getConfigService().saveConfig('crowi', {
        'security:registrationMode': 'Resricted',
        'security:registrationWhiteList': ['allowed@example.com', 'team@example.org'],
      });

      const res = await request(app).get('/api/admin/security').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Resricted',
        registrationWhiteList: ['allowed@example.com', 'team@example.org'],
        linkCardEnabled: true,
      });
    });

    describe('linkCardEnabled default (spec §6.2: missing / non-boolean -> true)', () => {
      it('reads true when the security:linkCardEnabled row is entirely missing', async () => {
        await crowi.model('Config').deleteMany({ ns: 'crowi', key: 'security:linkCardEnabled' }).exec();
        await crowi.getConfigService().load();

        const res = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(res.status).toBe(200);
        expect(res.body.linkCardEnabled).toBe(true);
      });

      it('reads true when the stored value is a hand-edited non-boolean', async () => {
        await crowi
          .model('Config')
          .updateOne({ ns: 'crowi', key: 'security:linkCardEnabled' }, { $set: { value: '"on"' } }, { upsert: true })
          .exec();
        await crowi.getConfigService().load();

        const res = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(res.status).toBe(200);
        expect(res.body.linkCardEnabled).toBe(true);
      });

      it('reflects an explicit false written via configService', async () => {
        await crowi.getConfigService().saveConfigValue('crowi', 'security:linkCardEnabled', false);

        const res = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(res.status).toBe(200);
        expect(res.body.linkCardEnabled).toBe(false);
      });
    });
  });

  describe('PUT /api/admin/security', () => {
    const validBody = {
      registrationMode: 'Closed' as const,
      registrationWhiteList: ['user@example.com'],
      linkCardEnabled: true,
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/admin/security').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/admin/security').set(authHeaders(userToken)).send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when registrationMode is outside the enum', async () => {
      const res = await request(app)
        .put('/api/admin/security')
        .set(authHeaders(adminToken))
        .send({
          ...validBody,
          registrationMode: 'Restricted', // correct spelling - intentionally rejected
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when registrationWhiteList is not an array', async () => {
      const res = await request(app)
        .put('/api/admin/security')
        .set(authHeaders(adminToken))
        .send({
          ...validBody,
          registrationWhiteList: 'allowed@example.com',
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when linkCardEnabled is missing', async () => {
      const { linkCardEnabled: _omit, ...bodyWithoutLinkCard } = validBody;
      const res = await request(app).put('/api/admin/security').set(authHeaders(adminToken)).send(bodyWithoutLinkCard);
      expect(res.status).toBe(400);
    });

    it('returns 400 when linkCardEnabled is not a boolean', async () => {
      const res = await request(app)
        .put('/api/admin/security')
        .set(authHeaders(adminToken))
        .send({ ...validBody, linkCardEnabled: 'true' });
      expect(res.status).toBe(400);
    });

    it('persists the registration security:* keys and returns the updated settings', async () => {
      const res = await request(app)
        .put('/api/admin/security')
        .set(authHeaders(adminToken))
        .send({
          registrationMode: 'Resricted',
          registrationWhiteList: ['user@example.com'],
          linkCardEnabled: false,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registrationMode: 'Resricted',
        registrationWhiteList: ['user@example.com'],
        linkCardEnabled: false,
      });

      // Round-trip via GET to verify the in-memory cache and the persisted
      // values are in sync.
      const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.registrationMode).toBe('Resricted');
      expect(getRes.body.registrationWhiteList).toEqual(['user@example.com']);
      expect(getRes.body.linkCardEnabled).toBe(false);
    });

    it('trims whitespace and drops empty entries from registrationWhiteList', async () => {
      const res = await request(app)
        .put('/api/admin/security')
        .set(authHeaders(adminToken))
        .send({
          registrationMode: 'Resricted',
          registrationWhiteList: ['  user@example.com  ', '', '   ', 'team@example.org'],
          linkCardEnabled: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.registrationWhiteList).toEqual(['user@example.com', 'team@example.org']);
    });

    it('does not touch unrelated keys in the crowi namespace', async () => {
      // Seed an unrelated config value first.
      await crowi.getConfigService().saveConfig('crowi', {
        'app:title': 'Custom Crowi Title',
      });

      const res = await request(app).put('/api/admin/security').set(authHeaders(adminToken)).send(validBody);
      expect(res.status).toBe(200);

      const cfg = crowi.getConfig();
      expect(cfg.crowi['app:title']).toBe('Custom Crowi Title');
      expect(cfg.crowi['security:registrationMode']).toBe('Closed');
    });

    /**
     * feature-config-write-durability AC-4/AC-6 — `linkCardEnabled`
     * writes via its own `saveConfigValue` call BEFORE the
     * registration-settings batch write, so a Mongo failure on
     * linkCardEnabled 500s the whole PUT and leaves both linkCardEnabled
     * and registration fields unpersisted (batch never runs). This order
     * ensures failed linkCardEnabled prevents the batch from running (AC-6
     * regression). Injected at the model layer (`Config.updateByParams`),
     * not by mocking `ConfigService` itself — a `ConfigService.prototype`
     * mock would pass even without this feature's `models/config.ts` fix,
     * since the handler's own try/catch alone already turns any rejection
     * into a 500.
     */
    describe('linkCardEnabled write failure propagation', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('a rejected Mongo write for linkCardEnabled 500s the response and persists NEITHER linkCardEnabled NOR the registration fields', async () => {
        const Config = crowi.model('Config');
        const originalUpdateByParams = Config.updateByParams.bind(Config);
        const updateByParamsSpy = jest.spyOn(Config, 'updateByParams').mockImplementation(async (ns: string, key: string, value: string) => {
          if (key === 'security:linkCardEnabled') {
            throw new Error('mongo write failed');
          }
          return originalUpdateByParams(ns, key, value);
        });

        const res = await request(app)
          .put('/api/admin/security')
          .set(authHeaders(adminToken))
          .send({
            registrationMode: 'Closed',
            registrationWhiteList: ['nope@example.com'],
            linkCardEnabled: false,
          });

        expect(res.status).toBe(500);
        // Only the linkCardEnabled write was even attempted — the
        // registration-settings batch write never started.
        expect(updateByParamsSpy).toHaveBeenCalledTimes(1);
        expect(updateByParamsSpy).toHaveBeenCalledWith('crowi', 'security:linkCardEnabled', false);

        // Nothing from this failed PUT was persisted — GET still shows
        // the pre-PUT (reset) defaults.
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.status).toBe(200);
        expect(getRes.body).toEqual({
          registrationMode: 'Open',
          registrationWhiteList: [],
          linkCardEnabled: true,
        });
      });
    });
  });
});
