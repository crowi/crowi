import request from 'supertest';

import { Fixture, app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 2 — integration tests for the migrated `user`
 * resource (4 endpoints behind `createJwtAuth`).
 *
 * The legacy ts-rest handler returned 401 manually; the Hono port lets
 * the middleware do it uniformly, so we verify both shapes here. The
 * 404 envelope (`USER_NOT_FOUND`) covers "no document" and non-viewable
 * accounts (deleted / invited / registered). Active and suspended users
 * are shown, since a suspended author's pages stay browseable — we test
 * both branches.
 *
 * `GET /user/:username/subpages` (feature-user-page-subpages-tab) is a
 * path-rooted, fully-recursive listing under `/user/:username/` — distinct
 * from the creator-rooted `pages` above. It also requires BOTH
 * `profile:read` and `pages:read` (the other three routes register only
 * `profile:read`) and is exercised against the real, parameter-expanded URL
 * so the AND-stacked `applyScope` calls actually match — see the
 * "scope boundary" describe block below.
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

  describe('GET /user/:username/subpages', () => {
    const SUBPAGES_USERNAME = 'user-subpages-owner';
    const SUBPAGES_EMAIL = 'user-subpages-owner@example.com';
    const PREFIX = `/user/${SUBPAGES_USERNAME}`;

    let subpagesOwner: UserDocument;

    beforeAll(async () => {
      const owner = await seedActiveUser({ name: 'Subpages Owner', username: SUBPAGES_USERNAME, email: SUBPAGES_EMAIL, password: 'Password!1' });
      subpagesOwner = owner.user;
    });

    afterEach(async () => {
      // Every fixture in this block lives under `/user/user-subpages-owner`
      // (self, exact) or `/user/user-subpages-owner...` (subtree + the
      // deliberate `2` cross-namespace probe) — a single prefix regex drops
      // them all between tests without touching the outer describe's fixtures.
      await Page().deleteMany({ path: { $regex: `^${PREFIX}` } });
    });

    afterAll(async () => {
      await User().deleteMany({ email: SUBPAGES_EMAIL });
    });

    it('lists subpages path-ascending, excluding the home page and a different namespace, including deep nesting', async () => {
      await Fixture.generate('Page', [
        { path: PREFIX, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }, // home page (self, no trailing slash)
        { path: `${PREFIX}/notes`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
        // deep nesting: `/project` itself is never created, only the leaf.
        { path: `${PREFIX}/project/deep/nested`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
        { path: `${PREFIX}2/other`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }, // different namespace
      ]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
      const paths = res.body.pages.map((p: { path: string }) => p.path);
      expect(paths).toEqual([`${PREFIX}/notes`, `${PREFIX}/project/deep/nested`]);
    });

    it('excludes the trailing-slash self-twin (a real, separate document from the home page) — regression for $ne: prefix', async () => {
      // No `/user/<username>` (no slash) document exists here — only the
      // twin at `/user/<username>/` itself, which the `^prefix` regex
      // would otherwise match (a string is always a prefix of itself).
      await Fixture.generate('Page', [
        { path: `${PREFIX}/`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
        { path: `${PREFIX}/real-child`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
      ]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      const paths = res.body.pages.map((p: { path: string }) => p.path);
      expect(paths).not.toContain(`${PREFIX}/`);
      expect(paths).toContain(`${PREFIX}/real-child`);
      expect(res.body.total).toBe(1);
    });

    it('excludes redirect and soft-deleted pages', async () => {
      await Fixture.generate('Page', [
        { path: `${PREFIX}/redirected`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published', redirectTo: `${PREFIX}/target` },
        { path: `${PREFIX}/removed`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'deleted' },
        { path: `${PREFIX}/visible`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
      ]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/visible`]);
      expect(res.body.total).toBe(1);
    });

    it('excludes wip/deprecated pages even under GRANT_PUBLIC', async () => {
      await Fixture.generate('Page', [
        { path: `${PREFIX}/wip-page`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'wip' },
        { path: `${PREFIX}/deprecated-page`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'deprecated' },
        { path: `${PREFIX}/ok`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
      ]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/ok`]);
      expect(res.body.total).toBe(1);
    });

    it('shows a draft page only to its own creator', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/draft-page`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'draft' }]);

      const asViewer = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(asViewer.body.total).toBe(0);
      expect(asViewer.body.pages).toEqual([]);

      const ownerToken = createJwtUtil(crowi).generateTokens(subpagesOwner).accessToken;
      const asOwner = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(asOwner.body.total).toBe(1);
      expect(asOwner.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/draft-page`]);
    });

    it('a restricted-grant page is visible only to grantedUsers/creator, and total never leaks hidden rows', async () => {
      await Fixture.generate('Page', [
        { path: `${PREFIX}/public-a`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' },
        {
          path: `${PREFIX}/restricted`,
          grant: Page().GRANT_RESTRICTED,
          grantedUsers: [subpagesOwner],
          creator: subpagesOwner,
          status: 'published',
        },
      ]);

      const asViewer = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(asViewer.status).toBe(200);
      expect(asViewer.body.total).toBe(1);
      expect(asViewer.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/public-a`]);

      const ownerToken = createJwtUtil(crowi).generateTokens(subpagesOwner).accessToken;
      const asOwner = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(asOwner.body.total).toBe(2);
    });

    it('wire-level: pages[] never carries a revision (or currentRevision/yjsState/extended) key', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/lean-row`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages.length).toBe(1);
      const row = res.body.pages[0];
      expect(row).not.toHaveProperty('revision');
      expect(row).not.toHaveProperty('currentRevision');
      expect(row).not.toHaveProperty('yjsState');
      expect(row).not.toHaveProperty('extended');
      expect(row.path).toBe(`${PREFIX}/lean-row`);
    });

    it('paginates via limit/offset without duplicates or gaps (no concurrent writes)', async () => {
      await Fixture.generate(
        'Page',
        Array.from({ length: 5 }, (_, i) => ({ path: `${PREFIX}/page-${i}`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' })),
      );

      const page1 = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      const page2 = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 2 })
        .set('Authorization', `Bearer ${viewerToken}`);
      const page3 = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 4 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(page1.body.pager).toEqual({ prev: null, next: 2, offset: 0 });
      expect(page2.body.pager).toEqual({ prev: 0, next: 4, offset: 2 });
      expect(page3.body.pager).toEqual({ prev: 2, next: null, offset: 4 });

      const allPaths = [...page1.body.pages, ...page2.body.pages, ...page3.body.pages].map((p: { path: string }) => p.path);
      expect(allPaths).toEqual([`${PREFIX}/page-0`, `${PREFIX}/page-1`, `${PREFIX}/page-2`, `${PREFIX}/page-3`, `${PREFIX}/page-4`]);
    });

    it('a create/delete race between two page-fetches never throws — the response stays well-formed and dedupe-able by _id', async () => {
      await Fixture.generate(
        'Page',
        Array.from({ length: 3 }, (_, i) => ({ path: `${PREFIX}/race-${i}`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' })),
      );

      const firstPage = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(firstPage.status).toBe(200);
      const firstIds = firstPage.body.pages.map((p: { _id: string }) => p._id);

      // Simulate a rename landing between the two page-fetches: a page that
      // would otherwise sort BEFORE the already-fetched rows is inserted,
      // shifting the offset boundary so the next fetch re-includes an
      // already-seen row.
      await Fixture.generate('Page', [{ path: `${PREFIX}/race-000-inserted`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }]);

      const secondPage = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 2 })
        .set('Authorization', `Bearer ${viewerToken}`);
      // The response must not blow up even though the boundary shifted.
      expect(secondPage.status).toBe(200);
      expect(Array.isArray(secondPage.body.pages)).toBe(true);
      const secondIds = secondPage.body.pages.map((p: { _id: string }) => p._id);
      // Any overlap is a plain repeated `_id` — exactly the shape a
      // client-side `Set`-based dedupe (see `UserSubpages`) can absorb
      // without crashing or losing rows.
      for (const id of secondIds) {
        expect(typeof id).toBe('string');
      }
      // A follow-up fetch from the top (the tab's `refetchOnMount:
      // 'always'` behaviour) always converges on the true, current set.
      const refetch = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(refetch.status).toBe(200);
      expect(refetch.body.total).toBe(4);
      expect(new Set(refetch.body.pages.map((p: { _id: string }) => p._id)).size).toBe(4);
      // (unused but documents intent: the pre-race first page's ids are a
      // subset of the converged refetch)
      expect(firstIds.every((id: string) => refetch.body.pages.some((p: { _id: string }) => p._id === id))).toBe(true);
    });

    it('400 VALIDATION_ERROR for out-of-range or non-integer limit/offset', async () => {
      const cases = [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 2.5 }];
      for (const query of cases) {
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).query(query).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('a large offset beyond total is not a validation error — 200 with an empty pages array and pager.next: null', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/only-one`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }]);

      const res = await request(app)
        .get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 100000 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages).toEqual([]);
      expect(res.body.pager.next).toBeNull();
    });

    it('returns 404 USER_NOT_FOUND for an unknown username', async () => {
      const res = await request(app).get('/api/v2/user/no-such-user/subpages').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 500 INTERNAL_ERROR when the model layer throws unexpectedly (no fold-to-empty-200)', async () => {
      const spy = jest.spyOn(Page(), 'findSubpagesByUserNamespace').mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
      } finally {
        spy.mockRestore();
      }
    });

    describe('scope boundary (RFC-0010) — profile:read AND pages:read, tested against the real expanded URL', () => {
      it('403 INSUFFICIENT_SCOPE with a profile:read-only token', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['profile:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
        expect(res.headers['www-authenticate']).toContain('insufficient_scope');
      });

      it('403 INSUFFICIENT_SCOPE with a pages:read-only token', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['pages:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
        expect(res.headers['www-authenticate']).toContain('insufficient_scope');
      });

      it('200 with a token holding both profile:read and pages:read', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['profile:read', 'pages:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(200);
      });

      it('200 with the umbrella read scope (implies both profile:read and pages:read)', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/v2/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(200);
      });
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
