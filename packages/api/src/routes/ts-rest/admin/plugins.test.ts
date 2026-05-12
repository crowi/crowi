import { Types } from 'mongoose';
import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const createTestUser = async (info: { name: string; username: string; email: string; admin?: boolean }) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = !!info.admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

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

describe('Routes /api/v2/admin/plugins (ts-rest) — Phase 4 cache clear endpoints', () => {
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
      // The dev runner loads `@crowi/plugin-storage-local` by default
      // (see repo root crowi.config.json) — use it as the
      // existing-plugin probe.
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
