import { ALL_CAPABILITIES, AppInfoResponseSchema, CapabilitySchema } from '@crowi/api-contract';
import request from 'supertest';
import { app, crowi } from 'src/test/setup';

/**
 * RFC-0006 Phase 3 — integration test for the migrated `app` resource.
 *
 * `GET /api/app/info` is now served by Hono (see
 * `packages/api/src/hono/handlers/app.ts`). The wire format is
 * `{ title: string | null, confidential: string | null, version: string,
 * apiVersion: string, capabilities: Capability[] }` where `title` is `null`
 * when the operator has not customised it (the `'Crowi'` seed value counts
 * as "not customised") and `confidential` is `null` when the
 * confidentiality notice (`app:confidential`) is unset/empty. `version` /
 * `apiVersion` / `capabilities` are the version-skew / feature-detection
 * signal read by the `@crowi/cli` end-user CLI. `capabilities` is validated
 * against the known `Capability` vocabulary (`STATIC_CAPABILITIES` +
 * `DYNAMIC_CAPABILITIES`, `@crowi/api-contract`'s `app-capabilities.ts`) —
 * see the `capabilities enum (Capability vocabulary)` describe block below.
 * `apiVersion` deliberately stays a plain `z.string()` rather than a
 * `z.literal` (see the doc comment on `AppInfoResponseSchema` in
 * `@crowi/api-contract`'s `schemas/app.ts`): the CLI's WARN-ONLY
 * version-skew probe parses this response with
 * `AppInfoResponseSchema.partial().safeParse(...)`, and a literal would make
 * that safeParse reject the whole body — not just the field — the moment a
 * future server advertises a different surface version, defeating the
 * warning it exists to produce.
 */
describe('GET /api/app/info (Hono)', () => {
  let Config: ReturnType<typeof crowi.model<'Config'>>;
  const APP_KEYS = ['app:title', 'app:confidential', 'security:registrationMode', 'security:linkCardEnabled'];

  const reloadConfigCache = async () => {
    await crowi.getConfigService().load();
  };

  beforeAll(async () => {
    Config = crowi.model('Config');
  });

  afterEach(async () => {
    await Config.deleteMany({ ns: 'crowi', key: { $in: APP_KEYS } });
    await reloadConfigCache();
  });

  it('responds 200 without authentication (public route)', async () => {
    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns title=null when the seed default is in place', async () => {
    await Config.updateConfig('crowi', 'app:title', 'Crowi');
    await reloadConfigCache();

    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns title=null when no app:title row exists', async () => {
    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns the configured title when the operator has customised it', async () => {
    await Config.updateConfig('crowi', 'app:title', 'My Wiki');
    await reloadConfigCache();

    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'My Wiki', confidential: null });
  });

  it('returns confidential=null when the notice is empty', async () => {
    await Config.updateConfig('crowi', 'app:confidential', '');
    await reloadConfigCache();

    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns the confidentiality notice when the operator has set it', async () => {
    await Config.updateConfig('crowi', 'app:confidential', 'For employees only');
    await reloadConfigCache();

    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: 'For employees only' });
  });

  it('reports the server version-skew / feature-detection signal', async () => {
    const res = await request(app).get('/api/app/info');
    expect(res.status).toBe(200);

    // `version` is the running @crowi/api package version (a non-empty
    // string); `apiVersion` is the API surface version.
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(res.body.version).toBe(crowi.version);
    expect(res.body.apiVersion).toBe('v2');

    // `capabilities` is a non-empty list that always advertises the
    // statically-compiled subsystems the CLI relies on. `link-card`
    // (feature-renderer-plugin-boundary Phase 3) is default-on, so it is
    // present here too (no `security:linkCardEnabled` row seeded yet).
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    expect(res.body.capabilities).toEqual(expect.arrayContaining(['oauth', 'pages', 'comments', 'bookmarks', 'attachments', 'notifications', 'link-card']));

    // `rendererStylesheets` (feature-renderer-plugin-boundary Phase 1) is
    // always an array. Phase 1's own loaded plugin set never registers one
    // (KaTeX's real `addStylesheet` call lands in Phase 2 — see
    // `registry.test.ts` for a synthetic-plugin isolation test of the
    // commit/drop mechanics), so it is empty here.
    expect(res.body.rendererStylesheets).toEqual([]);

    // The full response parses against the strict (non-partial)
    // AppInfoResponseSchema — every advertised capability is a known
    // Capability vocabulary member.
    expect(() => AppInfoResponseSchema.parse(res.body)).not.toThrow();
  });

  // AC: "capabilities フィールドが既知 vocabulary(STATIC_CAPABILITIES + 動的3値)の
  // enum として wire schema 上で検証される。未知の文字列を含む body が...厳密な parse で
  // 失敗することを unit test で示す。"
  describe('capabilities enum (Capability vocabulary)', () => {
    it('parses every STATIC_CAPABILITIES + DYNAMIC_CAPABILITIES value against CapabilitySchema', () => {
      expect(ALL_CAPABILITIES.length).toBeGreaterThan(0);
      for (const capability of ALL_CAPABILITIES) {
        expect(CapabilitySchema.safeParse(capability).success).toBe(true);
      }
    });

    it('rejects an unknown capability tag via CapabilitySchema', () => {
      expect(CapabilitySchema.safeParse('not-a-real-capability').success).toBe(false);
    });

    it('rejects a body with an unknown capability via the strict AppInfoResponseSchema parse', async () => {
      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);

      const bodyWithUnknownCapability = { ...res.body, capabilities: [...res.body.capabilities, 'not-a-real-capability'] };
      expect(AppInfoResponseSchema.safeParse(bodyWithUnknownCapability).success).toBe(false);
    });
  });

  // `canSelfRegister` is the public UX hint that lets the unauthenticated
  // login / register pages hide the registration form up front when the
  // operator has closed self-service registration. It is the single
  // `security:registrationMode !== 'Closed'` decision, so it stays true
  // for both Open and the (typo'd) `Resricted` value and only flips false
  // for `Closed`.
  describe('canSelfRegister', () => {
    it('is true for the Open registration mode', async () => {
      await Config.updateConfig('crowi', 'security:registrationMode', 'Open');
      await reloadConfigCache();

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.canSelfRegister).toBe(true);
    });

    it('is true for the Restricted registration mode (self-register allowed, pending approval)', async () => {
      // The stored value is the historical `Resricted` typo; the boolean
      // must not depend on that spelling.
      await Config.updateConfig('crowi', 'security:registrationMode', 'Resricted');
      await reloadConfigCache();

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.canSelfRegister).toBe(true);
    });

    it('is false for the Closed registration mode (invite-only)', async () => {
      await Config.updateConfig('crowi', 'security:registrationMode', 'Closed');
      await reloadConfigCache();

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.canSelfRegister).toBe(false);
    });
  });

  // `link-card` (feature-renderer-plugin-boundary Phase 3) mirrors
  // `canSelfRegister`'s missing/non-boolean/explicit-value coverage
  // pattern for the `security:linkCardEnabled` toggle.
  describe('link-card capability', () => {
    it('is present when no security:linkCardEnabled row exists (default-on)', async () => {
      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('link-card');
    });

    it('is present when the stored value is a hand-edited non-boolean (defends to default-on)', async () => {
      await Config.updateOne({ ns: 'crowi', key: 'security:linkCardEnabled' }, { $set: { value: '"on"' } }, { upsert: true }).exec();
      await reloadConfigCache();

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('link-card');
    });

    it('is present when explicitly true', async () => {
      await crowi.getConfigService().saveConfigValueDurable('crowi', 'security:linkCardEnabled', true);

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('link-card');
    });

    it('is absent when explicitly false', async () => {
      await crowi.getConfigService().saveConfigValueDurable('crowi', 'security:linkCardEnabled', false);

      const res = await request(app).get('/api/app/info');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).not.toContain('link-card');
    });
  });
});
