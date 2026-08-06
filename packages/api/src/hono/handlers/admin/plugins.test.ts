import { Types } from 'mongoose';
import request from 'supertest';
import type { CrowiPlugin } from '@crowi/plugin-api';
import s3Plugin from '@crowi/plugin-storage-aws-s3';
import openSearchPlugin from '@crowi/plugin-search-opensearch';
import googlePlugin from '@crowi/plugin-google';
import resendPlugin from '@crowi/plugin-mail-resend';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import ConfigService from 'src/service/config';
import { formatPluginConfigKey } from 'src/plugin/plugin-namespace';

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

describe('Routes /api/admin/plugins (Hono) — Phase 4 cache clear endpoints', () => {
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

  describe('POST /api/admin/plugins/render-cache/clear-all', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-all').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-all').set(authHeaders(userToken)).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('clears every entry and reports the count', async () => {
      await seedCacheEntry({ pluginName: '@crowi/plugin-a', embedKey: 'k1' });
      await seedCacheEntry({ pluginName: '@crowi/plugin-b', embedKey: 'k2' });
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-all').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.removedCount).toBe(2);
      expect(typeof res.body.clearedAt).toBe('string');

      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const remaining = await PluginRenderCache.countDocuments({}).exec();
      expect(remaining).toBe(0);
    });

    it('reports 0 when nothing was cached', async () => {
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-all').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body.removedCount).toBe(0);
    });
  });

  describe('POST /api/admin/plugins/render-cache/clear-plugin', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-plugin?name=foo').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/admin/plugins/render-cache/clear-plugin?name=foo').set(authHeaders(userToken)).send({});
      expect(res.status).toBe(403);
    });

    it('returns 404 when the plugin is not loaded', async () => {
      const res = await request(app)
        .post('/api/admin/plugins/render-cache/clear-plugin?name=@crowi/plugin-not-installed')
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
        .post(`/api/admin/plugins/render-cache/clear-plugin?name=${encodeURIComponent(targetName)}`)
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

describe('GET /api/admin/plugins — status/error fields (feature-plugin-registration-isolation AC-7)', () => {
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
    const res = await request(app).get('/api/admin/plugins');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a non-admin user', async () => {
    const res = await request(app).get('/api/admin/plugins').set(authHeaders(userToken));
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

    const res = await request(app).get('/api/admin/plugins').set(authHeaders(adminToken));

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
    const res = await request(app).get('/api/admin/plugins').set(authHeaders(adminToken));

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

describe('GET /api/admin/plugins/readiness (feature-plugin-config-readiness, feature-core-config-readiness-and-mail)', () => {
  let adminToken: string;
  let userToken: string;

  // The real `@crowi/plugin-storage-aws-s3` / `@crowi/plugin-search-opensearch`
  // package exports (not hand-typed stand-ins) — a future rename of the
  // declared `readiness.driver` / `requiredConfigFields` in either package
  // breaks this test instead of silently drifting from what's actually
  // shipped (reviewer advisory on feature-plugin-config-readiness).
  const S3_PLUGIN: CrowiPlugin = s3Plugin;
  const SEARCH_PLUGIN: CrowiPlugin = openSearchPlugin;
  const RESEND_PLUGIN: CrowiPlugin = resendPlugin;
  const CORE_MAIL_ISSUE = { id: 'core:mail', source: 'core', label: 'Mail', href: '/admin/mail', fields: [{ name: 'from', configured: false }] };
  // `@crowi/plugin-mail-smtp` is an IMPLICIT_DEFAULT_PLUGINS entry (@crowi/runner)
  // — always loaded in this harness, with `mail.driver` defaulting to
  // `'smtp'` — and (feature-core-config-readiness-and-mail) now declares a
  // real `readiness.host` requirement. Its `host` config key is unset by
  // default, so every test below that doesn't care about mail must
  // explicitly configure a real host (same pattern the S3/search tests
  // already use for `mail:from`) or it will pollute the expected `issues`.
  const SMTP_NAME = '@crowi/plugin-mail-smtp';
  const SMTP_HOST_KEY = formatPluginConfigKey(SMTP_NAME, 'host');
  const SMTP_ISSUE = {
    id: `plugin:${SMTP_NAME}`,
    source: 'plugin',
    label: 'SMTP',
    href: `/admin/plugins/edit?name=${encodeURIComponent(SMTP_NAME)}`,
    fields: [{ name: 'host', configured: false }],
  };
  const REAL_SMTP_HOST = 'smtp.example.com';

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Readiness Admin',
      username: 'readinessAdmin',
      email: 'readiness-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const normal = await createTestUser({
      name: 'Readiness Normal',
      username: 'readinessNormal',
      email: 'readiness-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  // `getLoadedPlugins()`/`selectedDrivers` are exercised against the REAL
  // bootstrapped `crowi.pluginManager` shared by this whole test file (no
  // crowi.config.json in this harness selects `s3`/`opensearch` for
  // real), so each test injects the real plugin objects above + a driver
  // selection directly (private-field access, same pattern
  // `plugins.test.ts`'s "surfaces a failed plugin" test above uses via
  // `jest.spyOn(manager, 'getFailedPlugins')`) and restores both afterwards
  // so later tests/describe blocks in this file see the original state.
  let originalLoadedPlugins: readonly CrowiPlugin[];
  // biome-ignore lint/suspicious/noExplicitAny: snapshot of a private field for restore
  let originalSelectedDrivers: any;

  beforeEach(() => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    originalLoadedPlugins = manager.getLoadedPlugins();
    // biome-ignore lint/suspicious/noExplicitAny: snapshot of a private field for restore
    originalSelectedDrivers = { ...(manager as any).selectedDrivers };
  });

  afterEach(async () => {
    const manager = crowi.pluginManager;
    if (!manager) return;
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
    (manager as any).loadedPlugins = originalLoadedPlugins;
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
    (manager as any).selectedDrivers = originalSelectedDrivers;
    await crowi
      .getConfigService()
      .deleteConfig('crowi', formatPluginConfigKey(S3_PLUGIN.name, 'bucket'))
      .catch(() => undefined);
    await crowi
      .getConfigService()
      .deleteConfig('crowi', formatPluginConfigKey(SEARCH_PLUGIN.name, 'url'))
      .catch(() => undefined);
    await crowi
      .getConfigService()
      .deleteConfig('crowi', 'mail:from')
      .catch(() => undefined);
    await crowi
      .getConfigService()
      .deleteConfig('crowi', SMTP_HOST_KEY)
      .catch(() => undefined);
    await crowi
      .getConfigService()
      .deleteConfig('crowi', formatPluginConfigKey(RESEND_PLUGIN.name, 'apiKey'))
      .catch(() => undefined);
    await crowi.getConfigService().load();
  });

  const injectPlugin = (plugin: CrowiPlugin, drivers: Partial<Record<'storage' | 'search' | 'mail', string>>) => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
    (manager as any).loadedPlugins = [...originalLoadedPlugins, plugin];
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
    (manager as any).selectedDrivers = { ...originalSelectedDrivers, ...drivers };
  };

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/admin/plugins/readiness');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a non-admin user', async () => {
    const res = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(userToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('AC-1: returns the core:mail issue plus the real SMTP host issue when nothing is configured (default harness state)', async () => {
    const res = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(res.status).toBe(200);
    // `@crowi/plugin-mail-smtp` is an implicit-default plugin with `mail`
    // already the default selected driver, and its own `host` field is
    // unset out of the box — so both the plugin issue and the core issue
    // are present with no injection needed (feature-core-config-readiness-and-mail).
    expect(res.body.issues).toEqual(expect.arrayContaining([SMTP_ISSUE, CORE_MAIL_ISSUE]));
    expect(res.body.issues).toHaveLength(2);
  });

  it('AC-1: returns only the core:mail issue once the SMTP host is configured, and mail:from is still the only remaining gap', async () => {
    await crowi.getConfigService().saveConfig('crowi', { [SMTP_HOST_KEY]: REAL_SMTP_HOST });

    const res = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [CORE_MAIL_ISSUE] });
  });

  it('AC-1/AC-3: the core:mail issue disappears once mail:from is saved (SMTP host also configured), without ever echoing the address', async () => {
    await crowi.getConfigService().saveConfig('crowi', { 'mail:from': 'noreply@example.com', [SMTP_HOST_KEY]: REAL_SMTP_HOST });

    const res = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
    expect(JSON.stringify(res.body)).not.toContain('noreply@example.com');
  });

  it('AC-2: includes the real S3 plugin bucket issue when unset, and clears it once bucket is saved — without ever echoing bucket/secret/url values', async () => {
    await crowi.getConfigService().saveConfig('crowi', { 'mail:from': 'noreply@example.com', [SMTP_HOST_KEY]: REAL_SMTP_HOST });
    injectPlugin(S3_PLUGIN, { storage: 's3' });

    const before = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      issues: [
        {
          id: `plugin:${S3_PLUGIN.name}`,
          source: 'plugin',
          // Derived from the real plugin's own declared `adminPlacement.label`
          // — not a hardcoded stand-in, so this breaks if it drifts.
          label: 'AWS S3',
          href: `/admin/plugins/edit?name=${encodeURIComponent(S3_PLUGIN.name)}`,
          fields: [{ name: 'bucket', configured: false }],
        },
      ],
    });
    const beforeJson = JSON.stringify(before.body);
    expect(beforeJson).not.toContain('secretAccessKey');
    expect(beforeJson).not.toMatch(/"(value|url|bucket)":/);

    await crowi.getConfigService().saveConfig('crowi', { [formatPluginConfigKey(S3_PLUGIN.name, 'bucket')]: 'my-real-bucket' });

    const after = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ issues: [] });
    expect(JSON.stringify(after.body)).not.toContain('my-real-bucket');
  });

  it('AC-3: reports the unset url for the real OpenSearch plugin when its driver is selected even though its own registry entry was never registered, and excludes it when a different driver is selected', async () => {
    await crowi.getConfigService().saveConfig('crowi', { 'mail:from': 'noreply@example.com', [SMTP_HOST_KEY]: REAL_SMTP_HOST });
    injectPlugin(SEARCH_PLUGIN, { search: 'opensearch' });

    const selected = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(selected.status).toBe(200);
    const selectedIssue = (selected.body.issues as Array<{ id: string; fields: { name: string; configured: boolean }[] }>).find(
      (issue) => issue.id === `plugin:${SEARCH_PLUGIN.name}`,
    );
    expect(selectedIssue).toEqual({
      id: `plugin:${SEARCH_PLUGIN.name}`,
      source: 'plugin',
      // Derived the same way as the S3 case above: real `adminPlacement.label`.
      label: 'OpenSearch',
      href: `/admin/plugins/edit?name=${encodeURIComponent(SEARCH_PLUGIN.name)}`,
      fields: [{ name: 'url', configured: false }],
    });
    expect(JSON.stringify(selected.body)).not.toMatch(/"url":\s*"/);

    // Same plugin, but a different search driver is selected — the issue
    // must disappear even though the plugin's own url is still unset.
    injectPlugin(SEARCH_PLUGIN, { search: 'elasticsearch' });
    const unselected = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(unselected.status).toBe(200);
    expect((unselected.body.issues as Array<{ id: string }>).some((issue) => issue.id === `plugin:${SEARCH_PLUGIN.name}`)).toBe(false);
  });

  it('AC-2/AC-3: the real SMTP mail issue and the core:mail issue coexist until both are resolved', async () => {
    const before = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(before.status).toBe(200);
    expect(before.body.issues).toEqual(expect.arrayContaining([CORE_MAIL_ISSUE, SMTP_ISSUE]));
    expect(before.body.issues).toHaveLength(2);

    await crowi.getConfigService().saveConfig('crowi', { 'mail:from': 'noreply@example.com', [SMTP_HOST_KEY]: REAL_SMTP_HOST });

    const after = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ issues: [] });
  });

  it('AC-2: when the real Resend plugin is the selected mail driver, its own apiKey issue (with its plugin edit href) replaces the SMTP one — and clears once apiKey is saved, without ever echoing it', async () => {
    await crowi.getConfigService().saveConfig('crowi', { 'mail:from': 'noreply@example.com' });
    injectPlugin(RESEND_PLUGIN, { mail: 'resend' });

    const before = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(before.status).toBe(200);
    // Switching the selected mail driver to resend means the (still-loaded)
    // SMTP plugin's issue no longer applies — only the real Resend
    // declaration's own field/href show up.
    expect(before.body).toEqual({
      issues: [
        {
          id: `plugin:${RESEND_PLUGIN.name}`,
          source: 'plugin',
          // Derived from the real plugin's own declared `adminPlacement.label`.
          label: 'Resend',
          href: `/admin/plugins/edit?name=${encodeURIComponent(RESEND_PLUGIN.name)}`,
          fields: [{ name: 'apiKey', configured: false }],
        },
      ],
    });
    expect(JSON.stringify(before.body)).not.toMatch(/"apiKey":\s*"/);

    await crowi.getConfigService().saveConfig('crowi', { [formatPluginConfigKey(RESEND_PLUGIN.name, 'apiKey')]: 're_test_00000000' });

    const after = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ issues: [] });
    expect(JSON.stringify(after.body)).not.toContain('re_test_00000000');
  });
});

/**
 * RFC-0014 phase 4 — the Google credential group must be indivisible.
 *
 * A client id and secret written as separate rows can fail between them,
 * leaving the instance holding a new id next to the previous secret: a
 * pair that never existed, cannot authenticate, and is visible to every
 * replica until someone notices. These tests pin that no such state is
 * reachable through the admin API.
 */
describe('PUT /api/admin/plugins/config — atomic credential group (RFC-0014 phase 4, AC-2/AC-3/AC-4)', () => {
  const ATOMIC_KEY = 'plugin:@crowi/plugin-google:__atomic:clientCredentials';
  const FLAT_ID_KEY = 'plugin:@crowi/plugin-google:clientId';
  const FLAT_SECRET_KEY = 'plugin:@crowi/plugin-google:clientSecret';
  let adminToken: string;
  let originalLoadedPlugins: readonly CrowiPlugin[];

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Atomic Admin',
      username: 'atomicAdmin',
      email: 'atomic-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;
  });

  beforeEach(() => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    originalLoadedPlugins = manager.getLoadedPlugins();
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields, same pattern as the readiness suite above
    (manager as any).loadedPlugins = [...originalLoadedPlugins, googlePlugin];
  });

  afterEach(async () => {
    const manager = crowi.pluginManager;
    // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
    if (manager) (manager as any).loadedPlugins = originalLoadedPlugins;
    jest.restoreAllMocks();
    const Config = crowi.model('Config');
    await Config.deleteByParams('crowi', ATOMIC_KEY).catch(() => undefined);
    await Config.deleteByParams('crowi', FLAT_ID_KEY).catch(() => undefined);
    await Config.deleteByParams('crowi', FLAT_SECRET_KEY).catch(() => undefined);
    await crowi.getConfigService().load();
  });

  const putConfig = (values: Record<string, unknown>) =>
    request(app).put('/api/admin/plugins/config').query({ name: '@crowi/plugin-google' }).set(authHeaders(adminToken)).send({ values });

  it('AC-2: writes ONLY the atomic document — never a per-field row that could survive on its own', async () => {
    const res = await putConfig({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(res.status).toBe(200);

    const Config = crowi.model('Config');
    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-google:/ }).exec();
    expect(rows.map((r) => r.key)).toEqual([ATOMIC_KEY]);

    // Consumers still read the flat pair.
    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi[FLAT_ID_KEY]).toBe('id-1');
    expect(crowi.getConfig().crowi[FLAT_SECRET_KEY]).toBe('secret-1');
  });

  it('AC-2: omitting the secret keeps the stored one instead of blanking it', async () => {
    await putConfig({ clientId: 'id-1', clientSecret: 'secret-1' });

    // The admin form omits an unchanged secret (it is never sent back to
    // the browser to begin with) — saving just the id must not wipe it.
    const res = await putConfig({ clientId: 'id-2' });
    expect(res.status).toBe(200);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi[FLAT_ID_KEY]).toBe('id-2');
    expect(crowi.getConfig().crowi[FLAT_SECRET_KEY]).toBe('secret-1');
  });

  it('AC-3: a rejected group write returns 500, leaves the previous pair intact, and never hot-reloads', async () => {
    await putConfig({ clientId: 'old-id', clientSecret: 'old-secret' });
    await crowi.getConfigService().load();

    const Config = crowi.model('Config');
    jest.spyOn(Config, 'updateAtomicConfigGroup').mockRejectedValueOnce(new Error('injected mongo failure'));
    const manager = crowi.pluginManager;
    const reconfigureSpy = manager ? jest.spyOn(manager, 'reconfigureAffected') : null;

    const res = await putConfig({ clientId: 'new-id', clientSecret: 'new-secret' });
    expect(res.status).toBe(500);

    // No hot reload for a save that never happened.
    expect(reconfigureSpy?.mock.calls ?? []).toHaveLength(0);

    // The DB still holds the previous COMPLETE pair, and no partial row
    // was left behind next to it.
    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-google:/ }).exec();
    expect(rows.map((r) => r.key)).toEqual([ATOMIC_KEY]);
    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi[FLAT_ID_KEY]).toBe('old-id');
    expect(crowi.getConfig().crowi[FLAT_SECRET_KEY]).toBe('old-secret');
  });

  it('AC-4: after a failed write on replica A, replica B reloading the shared DB sees only the previous complete pair — never a mixed one', async () => {
    await putConfig({ clientId: 'old-id', clientSecret: 'old-secret' });

    // Replica B: a second ConfigService over the SAME Mongo, standing in
    // for another api process.
    const replicaB = new ConfigService(crowi);
    await replicaB.load();
    expect(replicaB.config.crowi[FLAT_ID_KEY]).toBe('old-id');
    expect(replicaB.config.crowi[FLAT_SECRET_KEY]).toBe('old-secret');

    const Config = crowi.model('Config');
    jest.spyOn(Config, 'updateAtomicConfigGroup').mockRejectedValueOnce(new Error('injected mongo failure'));
    expect((await putConfig({ clientId: 'new-id', clientSecret: 'new-secret' })).status).toBe(500);

    await replicaB.load();
    const idAfter = replicaB.config.crowi[FLAT_ID_KEY];
    const secretAfter = replicaB.config.crowi[FLAT_SECRET_KEY];

    // The two mixed pairs are the actual failure mode: either would be a
    // configuration that never existed on any replica.
    expect({ id: idAfter, secret: secretAfter }).not.toEqual({ id: 'new-id', secret: 'old-secret' });
    expect({ id: idAfter, secret: secretAfter }).not.toEqual({ id: 'old-id', secret: 'new-secret' });
    expect({ id: idAfter, secret: secretAfter }).toEqual({ id: 'old-id', secret: 'old-secret' });
  });
});
