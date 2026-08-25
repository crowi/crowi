import { Types } from 'mongoose';
import request from 'supertest';
import { z } from 'zod/v3';
import type { CrowiPlugin } from '@crowi/plugin-api';
import s3Plugin from '@crowi/plugin-storage-aws-s3';
import gcsPlugin from '@crowi/plugin-storage-gcs';
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

/**
 * feature-storage-gcs Phase 1 (AC-1/AC-2) — `serviceAccountKey` validation
 * (single/multiple 422 issues), the `gcsConnection` atomic group's
 * indivisibility/fault behaviour (same shape as the Google block above),
 * and secret non-disclosure end-to-end through the admin API — the real
 * proof that the intermediate-`ZodEffects`-marker fix in
 * `schema-serializer.ts` (`inspectConfigFieldMetadata`) actually reaches the
 * wire: `serviceAccountKey`'s `@sensitive` marker sits on a `superRefine()`
 * `ZodEffects` node wrapped by `.default('')`.
 *
 * `@google-cloud/storage` is NOT mocked here (unlike `storage-gcs.test.ts`):
 * `reconfigure` constructs a real `Storage` client on every successful save,
 * but that construction is synchronous/local (no network, no eager PEM
 * validation beyond what Node's own PEM parser accepts) — a real (if
 * throwaway) PKCS8 key below keeps that safe.
 */
describe('PUT/GET /api/admin/plugins/config — GCS service-account key validation and secret non-disclosure (feature-storage-gcs AC-1/AC-2)', () => {
  const VALID_PEM =
    '-----BEGIN PRIVATE KEY-----\n' +
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDQPC6ixOhobdqW\n' +
    'SZo8Dvo0qqSavc71dNRK4eE48indb2w5mjw1KVUBL/vL/h/okeMjIgwaBgrFWM+C\n' +
    '3njzwRvF8PMq4FZe5eaQab6oiGBgIiEphSzHOz2yw6K6PFwvvL4gpA0+pXG4/s46\n' +
    '1Qb3l8TOxW3JRRZHh6StPiijRBad8mtd0a2yH0RtmrMdRO/6mKLvP0qSUcD05HcH\n' +
    'vJXH0lCH0n3Dd0GJ8huYcPZgoNAfjqxZebTh2lMMVze4SonljzW22undqBLxuooh\n' +
    'I7sMq71IpIzC2GuClhx4Qh4DVFNsaBcQBuiWfcBSN+NoEnqfi+zxUmpazc6l8Jld\n' +
    '+b/ZsIcJAgMBAAECggEAGPTLgIuxkFlxF++mhdHkM/VrEJYUtIdtzXMsjUj9kjmx\n' +
    'OmaVFmh3lPK5nlE8pQB9/LcPBPvqJMxv4z7zN0ByqgqGdCIqi8lJFI/tzxA4H7Fb\n' +
    'cNjSfOapTnBCo4gKItj/ntUWdsZ4fovALt4azYfhiQfxkEyAvu4fYvlnAKkvfjqI\n' +
    '4WVyMj78dhV+Rpaq2OSwyfs1QeuBJd9fqALrJX8s+wpKkZtJM650reMwIuwIBQjG\n' +
    'K75su2NvBjevEZmORbz/EEpMLVXm9rN9/0cPyuT5IWqky2WtV+l/n/pRA/SiAFp9\n' +
    'hVBI/lYSU8L0KTHjvl/rETlyRAllYS1JtgYb1jWR8QKBgQD3Qqez0+ExcLc5AtYQ\n' +
    'JuTpj/cFdEX+vF9hQbaUg5tC0iKcm6qdCaVL78j7rv0RtTTREDjoC2OAgVFGPBK5\n' +
    'DzMpDwmOkZyz7UqaLmN1d+NMHPwhE+kePSizy5UpbMUfQ18hA18p+o/fg6K2u49k\n' +
    'S4k8nAjNqAUjHOO8ZaGOASGnGQKBgQDXmGfB+PaJj1swRtn6Xj8tP3zVz6eSo3lc\n' +
    '3P7GvFj3tdlqhv82l/MR7yr+01oXzv5dVTQfRKozUeJrZCbnbVjwbKpdJ5P9CuZ7\n' +
    'FqFa0jupo1C0hy0KwOZn/rHJoBeYjFCA4gaFG0LOkHFMyiuZxLFG1hJF6DP9hHDk\n' +
    'PpnmMdWNcQKBgCZfnt1Gxc1Be/4KFaS+FIq3ABRFnlNRctAKPcbAwgjVye9aLVlf\n' +
    '1Np7JUsCNl5YLBFCHkLM+a1I5I8s5Y747+ywW8BXkuVNr2VMS71AVPNMEEkl6Oj7\n' +
    'fuSgdM7QBau7bfkWp99A9rEuocMQSsm6+1p/sNISAHIZmrJzZ2Y9gLaJAoGABJAS\n' +
    'KhXFyfWBvYzSUi0qcx+z2aaSalURXXjD35re2yc7GbkPr60ZlNiV9VytvHFCCuGh\n' +
    'v8OpQnrKKvGsrRswVa5HEL+krydK53H8KjrmzllJfPibaG3asnq+coDz3uOhVIj0\n' +
    'EF8aU9rUuwZQU+nIwrIHIvmeGBB0fzAf+7I0TdECgYEAzJdWT4lP6rZovp3CFmW9\n' +
    'o+QgdXZo01XqmXzOkbYWDI/SKfYD41dLkjd6UbRBt3ajrkTtmYsB/6c1zKoZPyT7\n' +
    'LYthDofzow5H0DcdBgCNgk5Rs1+MDZqF/YEl8uk/0kbA+QN3yCGGwiXgW1Qq8IpU\n' +
    'uFhNQxY41ULqJs36DPvRZ0Y=\n' +
    '-----END PRIVATE KEY-----\n';
  const validGcsKeyJson = (overrides: Partial<{ type: string; project_id: string; client_email: string; private_key: string }> = {}) =>
    JSON.stringify({
      type: 'service_account',
      project_id: 'key-project',
      client_email: 'sa@key-project.iam.gserviceaccount.com',
      private_key: VALID_PEM,
      ...overrides,
    });

  const ATOMIC_KEY = 'plugin:@crowi/plugin-storage-gcs:__atomic:gcsConnection';
  const FLAT_KEYS = ['bucket', 'prefix', 'projectId', 'serviceAccountKey'].map((f) => formatPluginConfigKey(gcsPlugin.name, f));

  /**
   * `PluginManager`'s `loadedPlugins`/`selectedDrivers` are private; this
   * describe block (like the pre-existing suites above) reaches into them
   * directly to graft the plugin under test into an already-booted manager
   * instead of re-running full plugin discovery. Narrowed to exactly the
   * two fields this block touches instead of `any`.
   */
  type PluginManagerPrivateAccess = {
    selectedDrivers: Record<string, string>;
    loadedPlugins: readonly CrowiPlugin[];
  };

  let adminToken: string;
  let originalLoadedPlugins: readonly CrowiPlugin[];
  let originalSelectedDrivers: Record<string, string>;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'GCS Admin',
      username: 'gcsAdmin',
      email: 'gcs-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;
  });

  beforeEach(() => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    originalLoadedPlugins = manager.getLoadedPlugins();
    const privateAccess = manager as unknown as PluginManagerPrivateAccess;
    originalSelectedDrivers = { ...privateAccess.selectedDrivers };
    privateAccess.loadedPlugins = [...originalLoadedPlugins, gcsPlugin];
  });

  afterEach(async () => {
    const manager = crowi.pluginManager;
    if (manager) {
      const privateAccess = manager as unknown as PluginManagerPrivateAccess;
      privateAccess.loadedPlugins = originalLoadedPlugins;
      privateAccess.selectedDrivers = originalSelectedDrivers;
    }
    jest.restoreAllMocks();
    const Config = crowi.model('Config');
    await Config.deleteByParams('crowi', ATOMIC_KEY).catch(() => undefined);
    for (const key of FLAT_KEYS) {
      await Config.deleteByParams('crowi', key).catch(() => undefined);
    }
    await crowi.getConfigService().load();
  });

  const putConfig = (values: Record<string, unknown>) =>
    request(app).put('/api/admin/plugins/config').query({ name: gcsPlugin.name }).set(authHeaders(adminToken)).send({ values });

  const getConfig = () => request(app).get('/api/admin/plugins/config').query({ name: gcsPlugin.name }).set(authHeaders(adminToken));

  it('reports bucket as the sole readiness field once gcs is the selected storage driver', async () => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    (manager as unknown as PluginManagerPrivateAccess).selectedDrivers = { ...originalSelectedDrivers, storage: 'gcs' };

    const res = await request(app).get('/api/admin/plugins/readiness').set(authHeaders(adminToken));
    expect(res.status).toBe(200);
    const issue = (res.body.issues as Array<{ id: string; fields: { name: string; configured: boolean }[] }>).find((i) => i.id === `plugin:${gcsPlugin.name}`);
    expect(issue).toEqual({
      id: `plugin:${gcsPlugin.name}`,
      source: 'plugin',
      label: 'Google Cloud Storage',
      href: `/admin/plugins/edit?name=${encodeURIComponent(gcsPlugin.name)}`,
      fields: [{ name: 'bucket', configured: false }],
    });
  });

  it('AC-2: writes the four fields as ONE atomic document, and GET reports serviceAccountKey as a masked secret', async () => {
    const putRes = await putConfig({ bucket: 'my-bucket', prefix: 'prod', projectId: '', serviceAccountKey: validGcsKeyJson() });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    const Config = crowi.model('Config');
    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-storage-gcs:/ }).exec();
    expect(rows.map((r) => r.key)).toEqual([ATOMIC_KEY]);

    const got = await getConfig();
    expect(got.status).toBe(200);
    const fields = got.body.fields as Array<{ name: string; kind: string }>;
    expect(fields.find((f) => f.name === 'serviceAccountKey')?.kind).toBe('secret');
    expect(got.body.values.serviceAccountKey).toEqual({ hasValue: true });
    expect(got.body.values.bucket).toBe('my-bucket');
    expect(got.body.values.prefix).toBe('prod');

    const serialized = JSON.stringify(got.body);
    expect(serialized).not.toContain('sa@key-project');
    expect(serialized).not.toContain('PRIVATE KEY');
  });

  it('AC-2: rejects an invalid (non-JSON) serviceAccountKey with a single 422 issue', async () => {
    const res = await putConfig({ bucket: 'my-bucket', serviceAccountKey: 'not json' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLUGIN_CONFIG_VALIDATION_FAILED');
    expect(res.body.error.issues).toEqual([{ path: ['serviceAccountKey'], message: 'Must be valid JSON object' }]);
  });

  it('AC-2: returns one 422 issue per missing required field when several are absent at once', async () => {
    const res = await putConfig({ bucket: 'my-bucket', serviceAccountKey: JSON.stringify({ type: 'service_account' }) });
    expect(res.status).toBe(422);
    expect(res.body.error.issues.map((i: { message: string }) => i.message)).toEqual([
      'project_id is required',
      'client_email is required',
      'private_key is required',
    ]);
    for (const issue of res.body.error.issues as Array<{ path: string[] }>) {
      expect(issue.path).toEqual(['serviceAccountKey']);
    }
  });

  it('AC-2: rejects a serviceAccountKey with the wrong "type" with a single 422 issue', async () => {
    const res = await putConfig({ bucket: 'my-bucket', serviceAccountKey: validGcsKeyJson({ type: 'not_a_service_account' }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLUGIN_CONFIG_VALIDATION_FAILED');
    expect(res.body.error.issues).toEqual([{ path: ['serviceAccountKey'], message: 'type must be "service_account"' }]);
  });

  it('AC-2: rejects a serviceAccountKey with an invalid PEM private_key with a single 422 issue', async () => {
    const res = await putConfig({ bucket: 'my-bucket', serviceAccountKey: validGcsKeyJson({ private_key: 'not-a-pem-block' }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLUGIN_CONFIG_VALIDATION_FAILED');
    expect(res.body.error.issues).toEqual([{ path: ['serviceAccountKey'], message: 'private_key must be a PEM private-key block' }]);
  });

  it('AC-2: omitting the secret on a later save keeps the previously stored one instead of blanking it', async () => {
    await putConfig({ bucket: 'my-bucket', serviceAccountKey: validGcsKeyJson() });

    // The admin form never re-sends an unchanged secret — saving just the
    // bucket rename must not wipe the stored key.
    const res = await putConfig({ bucket: 'my-bucket-renamed' });
    expect(res.status).toBe(200);

    await crowi.getConfigService().load();
    const flatSecretKey = formatPluginConfigKey(gcsPlugin.name, 'serviceAccountKey');
    expect(crowi.getConfig().crowi[flatSecretKey]).toBe(validGcsKeyJson());

    const got = await getConfig();
    expect(got.body.values.serviceAccountKey).toEqual({ hasValue: true });
    expect(got.body.values.bucket).toBe('my-bucket-renamed');
  });

  it('AC-2: a rejected group write returns 500, leaves the previous config intact, and never hot-reloads', async () => {
    await putConfig({ bucket: 'old-bucket', serviceAccountKey: validGcsKeyJson() });
    await crowi.getConfigService().load();

    const Config = crowi.model('Config');
    jest.spyOn(Config, 'updateAtomicConfigGroup').mockRejectedValueOnce(new Error('injected mongo failure'));
    const manager = crowi.pluginManager;
    const reconfigureSpy = manager ? jest.spyOn(manager, 'reconfigureAffected') : null;

    const res = await putConfig({ bucket: 'new-bucket', serviceAccountKey: validGcsKeyJson({ project_id: 'other-project' }) });
    expect(res.status).toBe(500);

    // No hot reload for a save that never happened.
    expect(reconfigureSpy?.mock.calls ?? []).toHaveLength(0);

    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-storage-gcs:/ }).exec();
    expect(rows.map((r) => r.key)).toEqual([ATOMIC_KEY]);

    await crowi.getConfigService().load();
    const flatBucketKey = formatPluginConfigKey(gcsPlugin.name, 'bucket');
    expect(crowi.getConfig().crowi[flatBucketKey]).toBe('old-bucket');
  });
});

/**
 * `googlePlugin`'s driver is never actually registered here (`registerAuth`
 * only runs during real plugin bootstrap, and `@crowi/plugin-google` isn't
 * in this harness's implicit-default set) — `crowi.getPlugins().auth.list()`
 * is stubbed directly instead, the same private-surface pattern the
 * readiness suite above uses for `getLoadedPlugins()`/`selectedDrivers`.
 *
 * Every real auth/storage plugin in this file (`googlePlugin`, `gcsPlugin`)
 * has ALL its config fields inside a single atomic group, so testing that a
 * non-group field change never gates needs a synthetic plugin with one
 * group plus one ungrouped field.
 */
describe('PUT /api/admin/plugins/config — linked-identities confirmation gate (feature-auth-plugin-credential-change-guard AC-1/AC-2/AC-3/AC-4/AC-5/AC-6/AC-7b)', () => {
  const SYNTH_DRIVER_NAME = 'synth-auth';
  const syntheticAuthPlugin: CrowiPlugin = {
    name: '@crowi/plugin-synth-auth-test',
    version: '0.0.0',
    configSchema: z
      .object({
        clientId: z.string().trim().default(''),
        clientSecret: z.string().trim().describe('@sensitive synthetic test secret').default(''),
        timeout: z.number().default(30),
      })
      .strict(),
    configAtomicGroups: [{ name: 'credentials', keys: ['clientId', 'clientSecret'], sensitive: true }],
  };
  const syntheticNonAuthPlugin: CrowiPlugin = {
    name: '@crowi/plugin-synth-non-auth-test',
    version: '0.0.0',
    configSchema: z
      .object({
        apiKey: z.string().trim().default(''),
      })
      .strict(),
    configAtomicGroups: [{ name: 'credentials', keys: ['apiKey'], sensitive: false }],
  };

  type PluginManagerLoadedPluginsAccess = {
    loadedPlugins: readonly CrowiPlugin[];
  };

  let adminToken: string;
  let originalLoadedPlugins: readonly CrowiPlugin[];
  let authListSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Linked Identities Admin',
      username: 'linkedIdentitiesAdmin',
      email: 'linked-identities-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;
  });

  beforeEach(() => {
    const manager = crowi.pluginManager;
    if (!manager) throw new Error('PluginManager not bootstrapped in harness');
    originalLoadedPlugins = manager.getLoadedPlugins();
    (manager as unknown as PluginManagerLoadedPluginsAccess).loadedPlugins = [
      ...originalLoadedPlugins,
      googlePlugin,
      syntheticAuthPlugin,
      syntheticNonAuthPlugin,
    ];
    // `syntheticNonAuthPlugin` deliberately never appears here: no
    // registered driver means it must never trigger the gate.
    authListSpy = jest.spyOn(crowi.getPlugins().auth, 'list').mockReturnValue([
      { driverName: 'google', plugin: googlePlugin.name },
      { driverName: SYNTH_DRIVER_NAME, plugin: syntheticAuthPlugin.name },
    ]);
  });

  afterEach(async () => {
    const manager = crowi.pluginManager;
    if (manager) (manager as unknown as PluginManagerLoadedPluginsAccess).loadedPlugins = originalLoadedPlugins;
    jest.restoreAllMocks();
    const Config = crowi.model('Config');
    await Config.deleteByParams('crowi', 'plugin:@crowi/plugin-google:__atomic:clientCredentials').catch(() => undefined);
    await Config.deleteByParams('crowi', 'plugin:@crowi/plugin-synth-auth-test:__atomic:credentials').catch(() => undefined);
    await Config.deleteByParams('crowi', 'plugin:@crowi/plugin-synth-auth-test:timeout').catch(() => undefined);
    await Config.deleteByParams('crowi', 'plugin:@crowi/plugin-synth-non-auth-test:__atomic:credentials').catch(() => undefined);
    await crowi.getConfigService().load();
    await crowi.model('UserIdentity').deleteMany({ provider: { $in: ['google', SYNTH_DRIVER_NAME] } });
  });

  const putGoogleConfig = (values: Record<string, unknown>, confirmLinkedIdentities?: boolean) =>
    request(app)
      .put('/api/admin/plugins/config')
      .query({ name: googlePlugin.name })
      .set(authHeaders(adminToken))
      .send({ values, ...(confirmLinkedIdentities !== undefined ? { confirmLinkedIdentities } : {}) });

  const putSynthConfig = (values: Record<string, unknown>, confirmLinkedIdentities?: boolean) =>
    request(app)
      .put('/api/admin/plugins/config')
      .query({ name: syntheticAuthPlugin.name })
      .set(authHeaders(adminToken))
      .send({ values, ...(confirmLinkedIdentities !== undefined ? { confirmLinkedIdentities } : {}) });

  const linkIdentity = (provider: string, providerUserId: string) =>
    crowi.model('UserIdentity').create({ userId: new Types.ObjectId(), provider, providerUserId });

  it('AC-1: a credential group change with linked identities and no confirmation returns 409 with the count, and writes nothing', async () => {
    await linkIdentity('google', 'sub-1');
    await linkIdentity('google', 'sub-2');

    const res = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINKED_IDENTITIES_EXIST');
    expect(res.body.error.count).toBe(2);

    const Config = crowi.model('Config');
    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-google:/ }).exec();
    expect(rows).toHaveLength(0);
  });

  it('AC-2: resubmitting the same request with confirmLinkedIdentities: true saves it', async () => {
    await linkIdentity('google', 'sub-1');

    const blocked = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(blocked.status).toBe(409);

    const confirmed = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' }, true);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ok).toBe(true);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-google:clientId']).toBe('id-1');
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-google:clientSecret']).toBe('secret-1');
  });

  it('AC-3: a credential group change with zero linked identities saves without confirmation', async () => {
    const res = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('AC-4: changing only a field outside every atomic group saves without confirmation, even with identities linked', async () => {
    await linkIdentity(SYNTH_DRIVER_NAME, 'sub-1');

    const res = await putSynthConfig({ timeout: 60 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-synth-auth-test:timeout']).toBe(60);
  });

  // The admin form's `buildRequest` sends every non-secret field's current
  // value on every save, not only the ones the operator edited — so a real
  // save touching only `timeout` still carries `clientId` in the body. The
  // gate must judge "changed" against the stored value, not against
  // presence in the request, or this would 409 even though the atomic
  // group's identity never moved.
  it('AC-4: a full-form save (unchanged clientId resent alongside a changed timeout) does not trigger the gate', async () => {
    await putSynthConfig({ clientId: 'client-1', timeout: 45 });
    await linkIdentity(SYNTH_DRIVER_NAME, 'sub-1');

    const res = await putSynthConfig({ clientId: 'client-1', timeout: 60 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-synth-auth-test:timeout']).toBe(60);
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-synth-auth-test:clientId']).toBe('client-1');
  });

  it('AC-7b: omitting clientSecret and changing only clientId still 409s when identities are linked (group-membership gate, not secret presence)', async () => {
    const seeded = await putGoogleConfig({ clientId: 'old-id', clientSecret: 'old-secret' });
    expect(seeded.status).toBe(200);

    await linkIdentity('google', 'sub-1');

    const res = await putGoogleConfig({ clientId: 'new-id' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINKED_IDENTITIES_EXIST');
    expect(res.body.error.count).toBe(1);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-google:clientId']).toBe('old-id');
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-google:clientSecret']).toBe('old-secret');
  });

  it('AC-5: a plugin that registers no auth driver saves an atomic-group change without confirmation, even with unrelated identities linked', async () => {
    await linkIdentity('google', 'sub-1');

    const res = await request(app)
      .put('/api/admin/plugins/config')
      .query({ name: syntheticNonAuthPlugin.name })
      .set(authHeaders(adminToken))
      .send({ values: { apiKey: 'new-key' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi[formatPluginConfigKey(syntheticNonAuthPlugin.name, 'apiKey')]).toBe('new-key');
  });

  it('AC-6: a save that touches no atomic-group field (unsent secret) never requires confirmation, even with identities linked', async () => {
    await linkIdentity('google', 'sub-1');

    const res = await putGoogleConfig({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const Config = crowi.model('Config');
    const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-google:/ }).exec();
    expect(rows).toHaveLength(0);
  });

  it('does not treat confirmLinkedIdentities as a config value', async () => {
    const res = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' }, true);
    expect(res.status).toBe(200);

    await crowi.getConfigService().load();
    expect(crowi.getConfig().crowi['plugin:@crowi/plugin-google:confirmLinkedIdentities']).toBeUndefined();
  });

  it('AC-1 (auth.list filter): does not count identities for a different driver the same registry lists', async () => {
    await linkIdentity(SYNTH_DRIVER_NAME, 'sub-1');

    const res = await putGoogleConfig({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(res.status).toBe(200);
    expect(authListSpy).toHaveBeenCalled();
  });
});
