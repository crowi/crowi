import request from 'supertest';

import { Fixture, app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import type { UserDocument } from 'src/models/user';
import { createTestUser } from 'src/test/test-helpers';
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

describe('Routes /api/user (Hono)', () => {
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
      const res = await request(app).get(`/api/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ username: TARGET_USERNAME, name: 'Target' });
      expect(res.body.createdPagesCount).toBeGreaterThanOrEqual(1);
      expect(res.body.bookmarksCount).toBeGreaterThanOrEqual(1);
      // feature-profile-stats-and-page-total — the fixture user in this
      // outer describe block never likes/comments, so both are exactly 0
      // here; the dedicated describe block below pins non-zero exact counts.
      expect(res.body.likesCount).toBe(0);
      expect(res.body.commentsCount).toBe(0);
      expect(Array.isArray(res.body.recentPages)).toBe(true);
      expect(Array.isArray(res.body.recentBookmarks)).toBe(true);
    });

    it('returns 404 USER_NOT_FOUND for an unknown username', async () => {
      const res = await request(app).get('/api/user/no-such-user').set('Authorization', `Bearer ${viewerToken}`);
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
        const res = await request(app).get(`/api/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
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
        const res = await request(app).get(`/api/user/${TARGET_USERNAME}`).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('USER_NOT_FOUND');
      } finally {
        targetUser.status = original;
        await targetUser.save();
      }
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/user/${TARGET_USERNAME}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  /**
   * feature-profile-stats-and-page-total — `likesCount` / `commentsCount`
   * are the target user's OWN actions (pages they liked, comments they
   * wrote), never activity their own pages received from others. A
   * dedicated fixture set is used here (rather than the outer describe's
   * shared `targetUser`) so the exact counts in the acceptance criteria
   * (2 likes, 3 comments) are pinned without coupling to other tests'
   * side effects on the shared fixture.
   */
  describe('GET /user/:username — likesCount / commentsCount (feature-profile-stats-and-page-total)', () => {
    const PATH_PREFIX = '/hono-user-profile-stats-test/';
    const STATS_USERNAME = 'profile-stats-user';
    const STATS_EMAIL = 'profile-stats-user@example.com';
    const OTHER_USERNAME = 'profile-stats-other';
    const OTHER_EMAIL = 'profile-stats-other@example.com';

    let statsUser: UserDocument;
    let statsToken: string;
    let otherToken: string;

    beforeAll(async () => {
      const stats = await seedActiveUser({ name: 'Stats User', username: STATS_USERNAME, email: STATS_EMAIL, password: 'Password!1' });
      statsUser = stats.user;
      statsToken = stats.accessToken;
      const other = await seedActiveUser({ name: 'Stats Other', username: OTHER_USERNAME, email: OTHER_EMAIL, password: 'Password!1' });
      otherToken = other.accessToken;
    });

    afterEach(async () => {
      const pages = await Page()
        .find({ path: { $regex: `^${PATH_PREFIX}` } })
        .select('_id');
      const pageIds = pages.map((p: { _id: unknown }) => p._id);
      const Comment = crowi.model('Comment');
      await Promise.all([Comment.deleteMany({ page: { $in: pageIds } }), Page().deleteMany({ path: { $regex: `^${PATH_PREFIX}` } })]);
    });

    afterAll(async () => {
      await User().deleteMany({ $or: [{ email: STATS_EMAIL }, { email: OTHER_EMAIL }] });
    });

    // Seeds a page (owned by `otherToken`, GRANT_PUBLIC by default) and
    // returns its id + latest revision id.
    const createStatsPage = async (name: string) => {
      const res = await request(app)
        .post('/api/pages')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ path: `${PATH_PREFIX}${name}`, body: `# ${name}` });
      expect(res.status).toBe(200);
      return { id: res.body.page._id as string, revisionId: res.body.page.revision._id as string };
    };

    it("counts only the target user's own likes/comments: dedupes a repeat like, excludes an unliked page, and excludes another user's likes/comments", async () => {
      const pageA = await createStatsPage('a');
      const pageB = await createStatsPage('b');
      const pageC = await createStatsPage('c'); // liked then unliked — must not count
      const pageD = await createStatsPage('d'); // only `other` interacts with this one

      const statsAuth = { Authorization: `Bearer ${statsToken}` };
      const otherAuth = { Authorization: `Bearer ${otherToken}` };

      // statsUser likes 2 distinct pages; a repeat like on pageA must not double-count.
      await request(app).post('/api/pages/like').set(statsAuth).send({ page_id: pageA.id });
      await request(app).post('/api/pages/like').set(statsAuth).send({ page_id: pageB.id });
      await request(app).post('/api/pages/like').set(statsAuth).send({ page_id: pageA.id });

      // statsUser likes pageC, then unlikes it — must not count.
      const likeC = await request(app).post('/api/pages/like').set(statsAuth).send({ page_id: pageC.id });
      expect(likeC.status).toBe(200);
      const unlikeC = await request(app).post('/api/pages/unlike').set(statsAuth).send({ page_id: pageC.id });
      expect(unlikeC.status).toBe(200);

      // `other` likes pageD — must never count toward statsUser.
      const otherLike = await request(app).post('/api/pages/like').set(otherAuth).send({ page_id: pageD.id });
      expect(otherLike.status).toBe(200);

      // statsUser writes 3 comments (one on each of pageA/B/C).
      for (const page of [pageA, pageB, pageC]) {
        const res = await request(app)
          .post('/api/comments')
          .set(statsAuth)
          .send({ page_id: page.id, revision_id: page.revisionId, comment: `stats comment on ${page.id}` });
        expect(res.status).toBe(200);
      }
      // `other` writes a comment on pageD — must never count toward statsUser.
      const otherComment = await request(app)
        .post('/api/comments')
        .set(otherAuth)
        .send({ page_id: pageD.id, revision_id: pageD.revisionId, comment: 'other comment' });
      expect(otherComment.status).toBe(200);

      const res = await request(app).get(`/api/user/${STATS_USERNAME}`).set(statsAuth);
      expect(res.status).toBe(200);
      expect(res.body.likesCount).toBe(2);
      expect(res.body.commentsCount).toBe(3);
      // Existing counts still return as before (shape parity).
      expect(typeof res.body.createdPagesCount).toBe('number');
      expect(typeof res.body.bookmarksCount).toBe('number');
    });

    it('computes likesCount/commentsCount via Page.countDocuments({ liker }) / Comment.countDocuments({ creator }) — DB-side counts on the indexed fields, never an app-side scan', async () => {
      const pageCountSpy = jest.spyOn(Page(), 'countDocuments');
      const Comment = crowi.model('Comment');
      const commentCountSpy = jest.spyOn(Comment, 'countDocuments');
      try {
        const res = await request(app).get(`/api/user/${STATS_USERNAME}`).set('Authorization', `Bearer ${statsToken}`);
        expect(res.status).toBe(200);

        const likerCall = (pageCountSpy.mock.calls as Array<[Record<string, unknown> | undefined]>).find(([filter]) => filter?.liker !== undefined);
        expect(likerCall).toBeDefined();
        expect(String((likerCall as [Record<string, unknown>])[0].liker)).toBe(String(statsUser._id));

        expect(commentCountSpy).toHaveBeenCalledWith({ creator: statsUser._id });
      } finally {
        pageCountSpy.mockRestore();
        commentCountSpy.mockRestore();
      }
    });

    it("counts a like/comment on a page the REQUESTING viewer cannot read — likesCount/commentsCount are the target user's own actions, never re-filtered by the current viewer's own grants", async () => {
      const before = await request(app).get(`/api/user/${STATS_USERNAME}`).set('Authorization', `Bearer ${statsToken}`);
      expect(before.status).toBe(200);
      const likesBefore = before.body.likesCount as number;
      const commentsBefore = before.body.commentsCount as number;

      // Restricted to statsUser only — no third party (creator or
      // grantedUsers) can read it via GET /pages(/list).
      const [restrictedPage] = await Fixture.generate('Page', [
        {
          path: `${PATH_PREFIX}viewer-cannot-read`,
          grant: Page().GRANT_RESTRICTED,
          grantedUsers: [statsUser._id],
          creator: statsUser._id,
          status: 'published',
          liker: [statsUser._id],
        },
      ]);
      await Fixture.generate('Comment', [{ page: restrictedPage._id, creator: statsUser._id, comment: 'stats comment on a page the viewer cannot read' }]);

      const stranger = await createTestUser({
        name: 'Profile Stats Stranger',
        username: 'profile-stats-stranger',
        email: 'profile-stats-stranger@example.com',
      });

      // `stranger` is neither the creator nor in `grantedUsers` — the page
      // above is invisible to them. likesCount/commentsCount must still
      // include it: they describe statsUser's OWN actions, independent of
      // who is asking (spec §プロフィール統計の主語).
      const res = await request(app).get(`/api/user/${STATS_USERNAME}`).set('Authorization', `Bearer ${stranger.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.likesCount).toBe(likesBefore + 1);
      expect(res.body.commentsCount).toBe(commentsBefore + 1);
    });
  });

  describe('GET /user/:username/bookmarks', () => {
    it('returns paginated bookmarks with pager + total', async () => {
      const res = await request(app)
        .get(`/api/user/${TARGET_USERNAME}/bookmarks`)
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
      const res = await request(app).get('/api/user/no-such-user/bookmarks').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('GET /user/:username/pages', () => {
    it('returns paginated pages with pager + total', async () => {
      const res = await request(app).get(`/api/user/${TARGET_USERNAME}/pages`).query({ limit: 10, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
      expect(res.body.pages.length).toBeGreaterThanOrEqual(1);
      expect(res.body.pages[0]).toMatchObject({ path: expect.stringContaining(TARGET_USERNAME) });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/user/${TARGET_USERNAME}/pages`);
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
      // Deliberately NOT `seedActiveUser`. That goes through
      // `User.createUserByEmailAndPassword`, which emits `activated` and then
      // calls back immediately without awaiting the handler — and
      // `events/user.ts`'s `onActivated` creates `/user/<username>`, exactly
      // the path this block's first fixture creates for itself. The two
      // writers race on the `path` unique index: the fixture usually wins, but
      // when the auto-creation lands first the fixture dies with E11000, which
      // is the intermittent failure this file kept producing under load. (And
      // when the fixture wins, `onActivated` renames it away to `/tmp/...`
      // instead — silently, so the failure looks like a missing page.)
      //
      // `createTestUser` seeds the document directly, so there is no
      // activation event and only one writer for the home page: this block's
      // own fixture, which is what it wants to assert on. No password is
      // needed — nothing here authenticates as the owner.
      const owner = await createTestUser({ name: 'Subpages Owner', username: SUBPAGES_USERNAME, email: SUBPAGES_EMAIL });
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/ok`]);
      expect(res.body.total).toBe(1);
    });

    it('shows a draft page only to its own creator', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/draft-page`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'draft' }]);

      const asViewer = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(asViewer.body.total).toBe(0);
      expect(asViewer.body.pages).toEqual([]);

      const ownerToken = createJwtUtil(crowi).generateTokens(subpagesOwner).accessToken;
      const asOwner = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(asViewer.status).toBe(200);
      expect(asViewer.body.total).toBe(1);
      expect(asViewer.body.pages.map((p: { path: string }) => p.path)).toEqual([`${PREFIX}/public-a`]);

      const ownerToken = createJwtUtil(crowi).generateTokens(subpagesOwner).accessToken;
      const asOwner = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 0 })
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(asOwner.body.total).toBe(2);
    });

    it('wire-level: pages[] never carries a revision (or currentRevision/yjsState/extended) key', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/lean-row`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }]);

      const res = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 0 })
        .set('Authorization', `Bearer ${viewerToken}`);
      const page2 = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 2, offset: 2 })
        .set('Authorization', `Bearer ${viewerToken}`);
      const page3 = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
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
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).query(query).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('a large offset beyond total is not a validation error — 200 with an empty pages array and pager.next: null', async () => {
      await Fixture.generate('Page', [{ path: `${PREFIX}/only-one`, grant: Page().GRANT_PUBLIC, creator: subpagesOwner, status: 'published' }]);

      const res = await request(app)
        .get(`/api/user/${SUBPAGES_USERNAME}/subpages`)
        .query({ limit: 10, offset: 100000 })
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pages).toEqual([]);
      expect(res.body.pager.next).toBeNull();
    });

    it('returns 404 USER_NOT_FOUND for an unknown username', async () => {
      const res = await request(app).get('/api/user/no-such-user/subpages').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 500 INTERNAL_ERROR when the model layer throws unexpectedly (no fold-to-empty-200)', async () => {
      const spy = jest.spyOn(Page(), 'findSubpagesByUserNamespace').mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
      } finally {
        spy.mockRestore();
      }
    });

    describe('scope boundary (RFC-0010) — profile:read AND pages:read, tested against the real expanded URL', () => {
      it('403 INSUFFICIENT_SCOPE with a profile:read-only token', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['profile:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
        expect(res.headers['www-authenticate']).toContain('insufficient_scope');
      });

      it('403 INSUFFICIENT_SCOPE with a pages:read-only token', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['pages:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
        expect(res.headers['www-authenticate']).toContain('insufficient_scope');
      });

      it('200 with a token holding both profile:read and pages:read', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['profile:read', 'pages:read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
        expect(res.status).toBe(200);
      });

      it('200 with the umbrella read scope (implies both profile:read and pages:read)', async () => {
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: subpagesOwner, scopes: ['read'], clientId: 'crowi-cli' });
        const res = await request(app).get(`/api/user/${SUBPAGES_USERNAME}/subpages`).set('Authorization', `Bearer ${oauthToken}`);
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
      const res = await request(app).get('/api/users').query({ limit: 50, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
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
      const res = await request(app).get('/api/users').query({ q: 'target' }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      const usernames = res.body.users.map((u: { username: string }) => u.username);
      expect(usernames).toContain(TARGET_USERNAME);
      expect(usernames).not.toContain(VIEWER_USERNAME);
    });

    it('paginates via limit/offset and exposes a next cursor', async () => {
      const res = await request(app).get('/api/users').query({ limit: 1, offset: 0 }).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.pager.next).toBe(1);
      expect(res.body.pager.prev).toBeNull();
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
