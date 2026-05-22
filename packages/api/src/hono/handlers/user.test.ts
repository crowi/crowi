import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 2 — integration tests for the migrated `user`
 * resource (3 endpoints behind `createJwtAuth`).
 *
 * The legacy ts-rest handler returned 401 manually; the Hono port lets
 * the middleware do it uniformly, so we verify both shapes here. The
 * 404 envelope (`USER_NOT_FOUND`) covers both "no document" and
 * "inactive user" by design — we test both branches so the legacy
 * existence-leak guard stays in place.
 */

const seedActiveUser = async (info: { name: string; username: string; email: string; password: string }) => {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email: info.email }, { username: info.username }] });
  return new Promise<{ user: UserDocument; accessToken: string }>((resolve, reject) => {
    User.createUserByEmailAndPassword(info.name, info.username, info.email, info.password, 'en', async (err, user) => {
      if (err) return reject(err);
      user.status = User.STATUS_ACTIVE;
      await user.save();
      const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
      resolve({ user, accessToken });
    });
  });
};

describe('Routes /api/v2/user (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  const Page = () => crowi.model('Page');
  const Bookmark = () => crowi.model('Bookmark');

  const TARGET_EMAIL = 'user-target@example.com';
  const TARGET_USERNAME = 'user-target';
  const VIEWER_EMAIL = 'user-viewer@example.com';
  const VIEWER_USERNAME = 'user-viewer';

  let targetUser: UserDocument;
  let viewerToken: string;

  beforeAll(async () => {
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();

    const target = await seedActiveUser({ name: 'Target', username: TARGET_USERNAME, email: TARGET_EMAIL, password: 'Password!1' });
    targetUser = target.user;
    const viewer = await seedActiveUser({ name: 'Viewer', username: VIEWER_USERNAME, email: VIEWER_EMAIL, password: 'Password!1' });
    viewerToken = viewer.accessToken;

    // Create a single public page owned by the target user so the
    // counts / lists are non-empty.
    await Page().createPage(`/user/${TARGET_USERNAME}/notes`, 'hello world', targetUser, {});

    // Create one bookmark owned by the target user (any page is fine).
    await Bookmark().add(await Page().findOne({ path: `/user/${TARGET_USERNAME}/notes` }), targetUser);
  });

  afterAll(async () => {
    await Page().deleteMany({ creator: targetUser._id });
    await Bookmark().deleteMany({ user: targetUser._id });
    await User().deleteMany({ $or: [{ email: TARGET_EMAIL }, { email: VIEWER_EMAIL }] });
    await Config().deleteMany({ ns: 'crowi' });
    await crowi.getConfigService().load();
  });

  describe('GET /user/:username', () => {
    it('returns the target user profile with counts and recent activity', async () => {
      const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ username: TARGET_USERNAME, name: 'Target' });
      expect(res.body.createdPagesCount).toBeGreaterThanOrEqual(1);
      expect(res.body.bookmarksCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.body.recentPages)).toBe(true);
      expect(Array.isArray(res.body.recentBookmarks)).toBe(true);
    });

    it('returns 404 USER_NOT_FOUND for an unknown username', async () => {
      const res = await request(app).get('/api/v2/user/no-such-user').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns 404 USER_NOT_FOUND for a suspended user (existence leak guard)', async () => {
      // Suspend the target user, hit the endpoint, then restore — keeps
      // the rest of the suite's state intact.
      const original = targetUser.status;
      targetUser.status = User().STATUS_SUSPENDED;
      await targetUser.save();
      try {
        const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('USER_NOT_FOUND');
      } finally {
        targetUser.status = original;
        await targetUser.save();
      }
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('GET /user/:username/bookmarks', () => {
    it('returns paginated bookmarks with pager + total', async () => {
      const res = await request(app)
        .get(`/api/v2/user/${TARGET_USERNAME}/bookmarks`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
      expect(res.body.bookmarks.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 USER_NOT_FOUND for an unknown username', async () => {
      const res = await request(app).get('/api/v2/user/no-such-user/bookmarks').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('GET /user/:username/pages', () => {
    it('returns paginated pages with pager + total', async () => {
      const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}/pages`).query({ limit: 10, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
      expect(res.body.pages.length).toBeGreaterThanOrEqual(1);
      expect(res.body.pages[0]).toMatchObject({ path: expect.stringContaining(TARGET_USERNAME) });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}/pages`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
