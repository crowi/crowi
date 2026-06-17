import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 2 — integration tests for the migrated `user`
 * resource (3 endpoints behind `createJwtAuth`).
 *
 * The legacy ts-rest handler returned 401 manually; the Hono port lets
 * the middleware do it uniformly, so we verify both shapes here. The
 * 404 envelope (`USER_NOT_FOUND`) covers "no document" and non-viewable
 * accounts (deleted / invited / registered). Active and suspended users
 * are shown, since a suspended author's pages stay browseable — we test
 * both branches.
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
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    // Snapshot the shared crowi config before wiping it (afterAll restores it
    // to the as-discovered installed state rather than leaving it empty).
    configSnapshot = await snapshotCrowiConfig(crowi);
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
    await restoreCrowiConfig(crowi, configSnapshot);
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

    it('shows the profile of a suspended user (their pages stay browseable)', async () => {
      // Suspend the target user, hit the endpoint, then restore — keeps
      // the rest of the suite's state intact.
      const original = targetUser.status;
      targetUser.status = User().STATUS_SUSPENDED;
      await targetUser.save();
      try {
        const res = await request(app).get(`/api/v2/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(200);
        expect(res.body.user).toMatchObject({ username: TARGET_USERNAME, name: 'Target' });
      } finally {
        targetUser.status = original;
        await targetUser.save();
      }
    });

    it('returns 404 USER_NOT_FOUND for a non-viewable (registered) user', async () => {
      // Registered/invited placeholders never had a real profile — they
      // stay hidden behind the same 404 envelope as an unknown username.
      const original = targetUser.status;
      targetUser.status = User().STATUS_REGISTERED;
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

      // The bookmarked page's creator must be populated (not a bare id) so
      // the page-row avatar renders instead of an empty placeholder.
      const bookmarkedPage = res.body.bookmarks[0].page;
      expect(bookmarkedPage).not.toBeNull();
      expect(typeof bookmarkedPage.creator).toBe('object');
      expect(bookmarkedPage.creator.username).toBe(TARGET_USERNAME);
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

  describe('GET /users (member directory)', () => {
    const SUSPENDED_EMAIL = 'user-suspended@example.com';
    const SUSPENDED_USERNAME = 'user-suspended';

    beforeAll(async () => {
      // A suspended user must never appear in the directory.
      const suspended = await seedActiveUser({ name: 'Suspended', username: SUSPENDED_USERNAME, email: SUSPENDED_EMAIL, password: 'Password!1' });
      suspended.user.status = User().STATUS_SUSPENDED;
      await suspended.user.save();
    });

    afterAll(async () => {
      await User().deleteMany({ email: SUSPENDED_EMAIL });
    });

    it('lists active users name-ascending with pager + total, excluding non-active users', async () => {
      const res = await request(app).get('/api/v2/users').query({ limit: 50, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.pager).toMatchObject({ offset: 0 });
      const usernames = res.body.users.map((u: { username: string }) => u.username);
      expect(usernames).toEqual(expect.arrayContaining([TARGET_USERNAME, VIEWER_USERNAME]));
      expect(usernames).not.toContain(SUSPENDED_USERNAME);

      // Directory items carry only the public shape — never email.
      const target = res.body.users.find((u: { username: string }) => u.username === TARGET_USERNAME);
      expect(target).toMatchObject({ username: TARGET_USERNAME, name: 'Target' });
      expect(target).not.toHaveProperty('email');

      // name-ascending: 'Target' < 'Viewer'.
      const names = res.body.users.map((u: { name: string }) => u.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });

    it('filters by q against username/name (case-insensitive)', async () => {
      const res = await request(app).get('/api/v2/users').query({ q: 'target' }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      const usernames = res.body.users.map((u: { username: string }) => u.username);
      expect(usernames).toContain(TARGET_USERNAME);
      expect(usernames).not.toContain(VIEWER_USERNAME);
    });

    it('paginates via limit/offset and exposes a next cursor', async () => {
      const res = await request(app).get('/api/v2/users').query({ limit: 1, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.pager.next).toBe(1);
      expect(res.body.pager.prev).toBeNull();
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get('/api/v2/users');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
