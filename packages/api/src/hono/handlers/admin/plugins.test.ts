import { Types } from 'mongoose';
import request from 'supertest';
import type { CrowiPlugin } from '@crowi/plugin-api';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';

const seedCacheEntry = async (overrides: Partial<{ pluginName: string; embedKey: string; pageId: string }> = {}) => {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  const now = new Date();
  return PluginRenderCache.create({
    pluginName: overrides.pluginName ?? '@crowi/plugin-test',
    pluginCacheVersion: 1,
    pageId: new Types.ObjectId(overrides.pageId ?? new Types.ObjectId().toHexString()),
    embedKey: overrides.embedKey ?? 'key-1',
    html: '<span>x</span>',
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    result: { html: '<span>x</span>' },
  });
};

describe('Routes /api/v2/admin/plugins (Hono) — Phase 4 cache clear endpoints', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Plugins Admin',
      username: 'pluginsAdmin',
      email: 'plugins-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Plugins Normal',
      username: 'pluginsNormal',
      email: 'plugins-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  describe('POST /api/v2/admin/plugins/render-cache/clear-all', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-all').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-all').set(authHeaders(userToken)).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('clears every entry and reports the count', async () => {
      await seedCacheEntry({ pluginName: '@crowi/plugin-a', embedKey: 'k1' });
      await seedCacheEntry({ pluginName: '@crowi/plugin-b', embedKey: 'k2' });
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-all').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.removedCount).toBe(2);
      expect(typeof res.body.clearedAt).toBe('string');

      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const remaining = await PluginRenderCache.countDocuments({}).exec();
      expect(remaining).toBe(0);
    });

    it('reports 0 when nothing was cached', async () => {
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-all').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body.removedCount).toBe(0);
    });
  });

  describe('POST /api/v2/admin/plugins/render-cache/clear-plugin', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-plugin?name=foo').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/v2/admin/plugins/render-cache/clear-plugin?name=foo').set(authHeaders(userToken)).send({});
      expect(res.status).toBe(403);
    });

    it('returns 404 when the plugin is not loaded', async () => {
      const res = await request(app)
        .post('/api/v2/admin/plugins/render-cache/clear-plugin?name=@crowi/plugin-not-installed')
        .set(authHeaders(adminToken))
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PLUGIN_NOT_FOUND');
    });

    it('clears only the named plugin entries when the plugin is loaded', async () => {
      // The implicit-default plugin set always loads `@crowi/plugin-storage-local`
      // (IMPLICIT_DEFAULT_PLUGINS in @crowi/runner), independent of any
      // crowi.config.json — use it as the existing-plugin probe.
      const loaded = crowi.pluginManager?.getLoadedPlugins() ?? [];
      const targetName = loaded[0]?.name;
      // If the dev runner config in this test env doesn't carry any
      // plugins, skip the loaded-name branch; the 404 case above
      // already covers the not-loaded path.
      if (!targetName) {
        return;
      }
      await seedCacheEntry({ pluginName: targetName, embedKey: 'a' });
      await seedCacheEntry({ pluginName: '@crowi/plugin-other', embedKey: 'b' });

      const res = await request(app)
        .post(`/api/v2/admin/plugins/render-cache/clear-plugin?name=${encodeURIComponent(targetName)}`)
        .set(authHeaders(adminToken))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.removedCount).toBe(1);

      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const remaining = await PluginRenderCache.find({}).lean().exec();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].pluginName).toBe('@crowi/plugin-other');
    });
  });
});

describe('GET /api/v2/admin/plugins — status/error fields (feature-plugin-registration-isolation AC-7)', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Plugins List Admin',
      username: 'pluginsListAdmin',
      email: 'plugins-list-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Plugins List Normal',
      username: 'pluginsListNormal',
      email: 'plugins-list-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v2/admin/plugins');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a non-admin user', async () => {
    const res = await request(app).get('/api/v2/admin/plugins').set(authHeaders(userToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('surfaces a failed plugin as status: "failed" with its error message, alongside status: "active" loaded plugins', async () => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    const failedPlugin: CrowiPlugin = { name: '@crowi/plugin-boom', version: '0.0.0' };
    // `getFailedPlugins()` is normally empty in this harness (nothing fails
    // to activate in the dev runner's plugin set) — stub it the same way
    // `plugin-router-smoke.test.ts` stubs `getLoadedPlugins()` to exercise
    // a synthetic case without touching the shared crowi instance.
    jest.spyOn(manager, 'getFailedPlugins').mockReturnValue([{ plugin: failedPlugin, error: 'activation exploded' }]);

    const res = await request(app).get('/api/v2/admin/plugins').set(authHeaders(adminToken));

    expect(res.status).toBe(200);
    const failedEntry = (res.body.plugins as Array<{ name: string; status: string; error?: string }>).find((p) => p.name === '@crowi/plugin-boom');
    expect(failedEntry).toMatchObject({ status: 'failed', error: 'activation exploded' });

    const activeEntries = (res.body.plugins as Array<{ name: string; status: string }>).filter((p) => p.name !== '@crowi/plugin-boom');
    // The dev runner's implicit-default plugin set always loads at least
    // one plugin (see the `clears only the named plugin entries` test
    // above) — every one of those is `status: 'active'`.
    expect(activeEntries.length).toBeGreaterThan(0);
    for (const entry of activeEntries) {
      expect(entry.status).toBe('active');
    }
  });

  it("surfaces a primary plugin's declared modelAccess allow-list (feature-plugin-capability-scoping)", async () => {
    const res = await request(app).get('/api/v2/admin/plugins').set(authHeaders(adminToken));

    expect(res.status).toBe(200);
    const plugins = res.body.plugins as Array<{ name: string; modelAccess?: string[] }>;
    const byName = new Map(plugins.map((p) => [p.name, p.modelAccess]));

    // `@crowi/plugin-search-mongo` is one of the `IMPLICIT_DEFAULT_PLUGINS`
    // (see `@crowi/runner`'s `config-file.ts`), so it is always loaded even
    // with no `crowi.config.json` present (this test harness's `ROOT_DIR` /
    // `process.cwd()` is `packages/api`, which has none) — a read-only
    // `ctx.model()` user, so its declared allow-list is exactly the models
    // it reads (see `driver.ts`). The other primary plugins
    // (search-elasticsearch/opensearch, slack) declare their own
    // `modelAccess` too — asserted directly against their exported
    // `CrowiPlugin` object in each package's own test suite, since they
    // are not part of this harness's implicit/no-config plugin set.
    expect(byName.get('@crowi/plugin-search-mongo')).toEqual(['Page', 'Revision']);
  });
});
