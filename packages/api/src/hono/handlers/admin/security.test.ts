import { SecuritySettingsSchema, UpdateSecuritySettingsRequestSchema } from '@crowi/api-contract';
import request from 'supertest';
import { app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import { isHtmlSanitizationEnabled } from 'src/util/admin-config';
import { createJwtUtil } from 'src/util/jwt';

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
  // The HTML policy key is normally absent; deleting it keeps every case starting from "never saved".
  await crowi.model('Config').deleteMany({ ns: 'crowi', key: 'security:htmlSanitizationEnabled' }).exec();
  await configService.load();
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
        htmlSanitizationEnabled: true,
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
        htmlSanitizationEnabled: true,
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

    it('accepts a body without linkCardEnabled and keeps the stored value', async () => {
      await crowi.getConfigService().saveConfigValue('crowi', 'security:linkCardEnabled', false);
      const { linkCardEnabled: _omit, ...bodyWithoutLinkCard } = validBody;
      const res = await request(app).put('/api/admin/security').set(authHeaders(adminToken)).send(bodyWithoutLinkCard);
      expect(res.status).toBe(200);
      expect(res.body.linkCardEnabled).toBe(false);
      expect(res.body.registrationMode).toBe('Closed');
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
        htmlSanitizationEnabled: true,
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
          htmlSanitizationEnabled: true,
        });
      });
    });

    describe('html-policy-write-contract', () => {
      const KEY = 'security:htmlSanitizationEnabled';
      const rowFor = (key: string) => crowi.model('Config').findOne({ ns: 'crowi', key }).lean().exec();
      const put = (body: unknown) =>
        request(app)
          .put('/api/admin/security')
          .set(authHeaders(adminToken))
          .send(body as object);

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('rejects unauthenticated, non-admin, PAT and OAuth callers without touching the Config row', async () => {
        const jwtUtil = createJwtUtil(crowi);
        const { user } = await createTestUser({ name: 'Sec OAuth Admin', username: 'secOauthAdmin', email: 'sec-oauth-admin@example.com', admin: true });
        const oauthToken = jwtUtil.signOauthAccessToken({ user, scopes: ['read'], clientId: 'crowi-cli' });
        const body = { htmlSanitizationEnabled: false };

        expect((await request(app).put('/api/admin/security').send(body)).status).toBe(401);
        expect((await request(app).put('/api/admin/security').set(authHeaders(userToken)).send(body)).status).toBe(403);
        expect((await request(app).put('/api/admin/security').set('Authorization', `Bearer ${oauthToken}`).send(body)).status).toBe(403);
        expect(await rowFor(KEY)).toBeNull();
      });

      it('saves false explicitly and reads it back from GET and the response', async () => {
        const res = await put({ htmlSanitizationEnabled: false });
        expect(res.status).toBe(200);
        expect(res.body.htmlSanitizationEnabled).toBe(false);
        expect((await rowFor(KEY))?.value).toBe('false');
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.body).toEqual(res.body);
      });

      it('each field alone updates only that field and never creates the omitted keys', async () => {
        const res = await put({ registrationMode: 'Closed' });
        expect(res.status).toBe(200);
        expect(await rowFor(KEY)).toBeNull();
        expect(res.body).toMatchObject({ registrationMode: 'Closed', registrationWhiteList: [], linkCardEnabled: true, htmlSanitizationEnabled: true });

        expect((await put({ registrationWhiteList: [' a@example.com ', ''] })).body).toMatchObject({
          registrationMode: 'Closed',
          registrationWhiteList: ['a@example.com'],
        });
        expect((await put({ registrationWhiteList: [] })).body.registrationWhiteList).toEqual([]);

        const linkCard = await put({ linkCardEnabled: false });
        expect(linkCard.body).toMatchObject({ registrationMode: 'Closed', linkCardEnabled: false, htmlSanitizationEnabled: true });
        expect(await rowFor(KEY)).toBeNull();
      });

      it('an empty object is a 200 no-op that neither saves nor notifies', async () => {
        const configService = crowi.getConfigService();
        const saveConfig = jest.spyOn(configService, 'saveConfig');
        const saveConfigValue = jest.spyOn(configService, 'saveConfigValue');
        const notify = jest.spyOn(configService, 'notifyUpdated');

        const res = await put({});
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ registrationMode: 'Open', registrationWhiteList: [], linkCardEnabled: true, htmlSanitizationEnabled: true });
        expect(saveConfig).not.toHaveBeenCalled();
        expect(saveConfigValue).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      });

      it('a toggle-only PUT does not roll back a registration change made by another admin', async () => {
        await crowi.getConfigService().saveConfig('crowi', { 'security:registrationMode': 'Closed' });
        const res = await put({ htmlSanitizationEnabled: false });
        expect(res.status).toBe(200);
        expect(res.body.registrationMode).toBe('Closed');
      });

      it('skips the registration batch when no registration field is present', async () => {
        const saveConfig = jest.spyOn(crowi.getConfigService(), 'saveConfig');
        expect((await put({ linkCardEnabled: false, htmlSanitizationEnabled: false })).status).toBe(200);
        expect(saveConfig).not.toHaveBeenCalled();
      });

      it('writes only the present registration keys in the batch', async () => {
        const saveConfig = jest.spyOn(crowi.getConfigService(), 'saveConfig');
        expect((await put({ registrationMode: 'Resricted' })).status).toBe(200);
        expect(saveConfig).toHaveBeenCalledWith('crowi', { 'security:registrationMode': 'Resricted' });
      });

      it('a failed linkCardEnabled save leaves the new key untouched', async () => {
        const Config = crowi.model('Config');
        const original = Config.updateByParams.bind(Config);
        jest.spyOn(Config, 'updateByParams').mockImplementation(async (ns: string, key: string, value: string) => {
          if (key === 'security:linkCardEnabled') throw new Error('mongo write failed');
          return original(ns, key, value);
        });
        const res = await put({ linkCardEnabled: false, htmlSanitizationEnabled: false });
        expect(res.status).toBe(500);
        expect(await rowFor(KEY)).toBeNull();
      });

      it('a failed registration save leaves the new key untouched and keeps the earlier link-card save', async () => {
        jest.spyOn(crowi.getConfigService(), 'saveConfig').mockRejectedValue(new Error('batch failed'));
        const res = await put({ linkCardEnabled: false, registrationMode: 'Closed', htmlSanitizationEnabled: false });
        expect(res.status).toBe(500);
        expect(await rowFor(KEY)).toBeNull();
        jest.restoreAllMocks();
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.body).toMatchObject({ registrationMode: 'Open', linkCardEnabled: false, htmlSanitizationEnabled: true });
      });

      it('a failed write of the new key is a 500 that keeps the previous value', async () => {
        await crowi.getConfigService().saveConfigValue('crowi', KEY, true);
        const configService = crowi.getConfigService();
        const original = configService.saveConfigValue.bind(configService);
        jest.spyOn(configService, 'saveConfigValue').mockImplementation(async (ns: string, key: string, value: unknown) => {
          if (key === KEY) throw new Error('mongo write failed');
          return original(ns, key, value);
        });
        const res = await put({ linkCardEnabled: false, htmlSanitizationEnabled: false });
        expect(res.status).toBe(500);
        jest.restoreAllMocks();
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.body).toMatchObject({ linkCardEnabled: false, htmlSanitizationEnabled: true });
      });

      it('a notify failure after the database write is a 500 but the new value is stored', async () => {
        jest.spyOn(crowi.getConfigService(), 'notifyUpdated').mockRejectedValueOnce(new Error('notify failed'));
        const res = await put({ htmlSanitizationEnabled: false });
        expect(res.status).toBe(500);
        expect((await rowFor(KEY))?.value).toBe('false');
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.body.htmlSanitizationEnabled).toBe(false);
      });
    });

    describe('html-policy-schema-shape', () => {
      const put = (body: unknown) =>
        request(app)
          .put('/api/admin/security')
          .set(authHeaders(adminToken))
          .send(body as object);

      it('GET and PUT 200 bodies carry all four fields with the right types', async () => {
        const shape = {
          registrationMode: expect.any(String),
          registrationWhiteList: expect.any(Array),
          linkCardEnabled: expect.any(Boolean),
          htmlSanitizationEnabled: expect.any(Boolean),
        };
        const getRes = await request(app).get('/api/admin/security').set(authHeaders(adminToken));
        expect(getRes.body).toEqual(shape);
        expect((await put({})).body).toEqual(shape);
        expect((await put({ registrationMode: 'Open', registrationWhiteList: [], linkCardEnabled: true })).body).toEqual(shape);
        expect(SecuritySettingsSchema.safeParse(getRes.body).success).toBe(true);
        expect(UpdateSecuritySettingsRequestSchema.safeParse({}).success).toBe(true);
      });

      it.each([
        { htmlSanitizationEnabled: null },
        { htmlSanitizationEnabled: 'false' },
        { htmlSanitizationEnabled: 0 },
        { linkCardEnabled: null },
        { registrationWhiteList: [1] },
      ])('rejects the invalid value %j with 400 and saves nothing', async (body) => {
        const res = await put(body);
        expect(res.status).toBe(400);
        const row = await crowi.model('Config').findOne({ ns: 'crowi', key: 'security:htmlSanitizationEnabled' }).lean().exec();
        expect(row).toBeNull();
      });
    });

    describe('html-policy-defaults', () => {
      const KEY = 'security:htmlSanitizationEnabled';
      const readFlag = async () => (await request(app).get('/api/admin/security').set(authHeaders(adminToken))).body.htmlSanitizationEnabled;
      const setRaw = async (value: string) => {
        await crowi.model('Config').updateOne({ ns: 'crowi', key: KEY }, { $set: { value } }, { upsert: true }).exec();
        await crowi.getConfigService().load();
      };

      it('reads true when the row is missing', async () => {
        expect(await readFlag()).toBe(true);
      });

      it.each(['null', '"false"', '0', '"off"'])('reads true for the non-boolean stored value %s', async (raw) => {
        await setRaw(raw);
        expect(await readFlag()).toBe(true);
      });

      it('reads false only for a stored boolean false and true for true', async () => {
        await setRaw('false');
        expect(await readFlag()).toBe(false);
        await setRaw('true');
        expect(await readFlag()).toBe(true);
      });

      it('isHtmlSanitizationEnabled falls back to true when the config cannot be read', () => {
        const broken = {
          getConfig: () => {
            throw new Error('boom');
          },
        } as unknown as typeof crowi;
        expect(isHtmlSanitizationEnabled(broken)).toBe(true);
      });
    });
  });
});
