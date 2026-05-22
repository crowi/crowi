import { Types } from 'mongoose';
import request from 'supertest';

import { Fixture, app, crowi } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `bookmark` resource. Wire-format parity is the primary thing under
 * test: the legacy `{ bookmark: null }` fallback for missing / not-
 * granted pages, the `{ ok: true }` no-op delete, pager arithmetic,
 * and the 401 / 400 envelopes from the Hono middleware.
 */

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const createTestUser = async (info: { name: string; username: string; email: string }) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Bookmark = crowi.model('Bookmark');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').lean();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter), Bookmark.deleteMany({ page: { $in: pageIds } })]);
};

const createPageViaApi = async (accessToken: string, path: string, body: string) => {
  const res = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path, body });
  if (res.status !== 200) {
    throw new Error(`Failed to seed page (${path}): ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.page as { _id: string; path: string };
};

describe('Routes /api/v2/bookmarks (Hono)', () => {
  const PATH_PREFIX = '/hono-bookmark-test/';
  let accessToken: string;
  let otherAccessToken: string;
  let userId: string;

  beforeAll(async () => {
    const owner = await createTestUser({
      name: 'Bookmark Test',
      username: 'honoBookmarkTester',
      email: 'hono-bookmark-tester@example.com',
    });
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();

    const other = await createTestUser({
      name: 'Bookmark Other',
      username: 'honoBookmarkOther',
      email: 'hono-bookmark-other@example.com',
    });
    otherAccessToken = other.accessToken;
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('GET /api/v2/bookmarks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/bookmarks').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when page_id is not a valid ObjectId', async () => {
      const res = await request(app).get('/api/v2/bookmarks').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns { bookmark: null } when the user has not bookmarked the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}unbookmarked`, '# nope');

      const res = await request(app).get('/api/v2/bookmarks').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.bookmark).toBeNull();
    });

    it('returns the bookmark when the user has bookmarked the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}bookmarked`, '# yep');

      const addRes = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(addRes.status).toBe(200);
      expect(addRes.body.bookmark).not.toBeNull();

      const res = await request(app).get('/api/v2/bookmarks').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.bookmark).not.toBeNull();
      expect(res.body.bookmark.page._id).toBe(page._id);
      expect(res.body.bookmark.user).toBe(userId);
    });
  });

  describe('POST /api/v2/bookmarks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/bookmarks').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when page_id is malformed', async () => {
      const res = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns { bookmark: null } when page does not exist (legacy parity)', async () => {
      const res = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(200);
      expect(res.body.bookmark).toBeNull();
    });

    it('creates a bookmark for an accessible page and returns it', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}create`, '# add');

      const res = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.bookmark).not.toBeNull();
      expect(res.body.bookmark._id).toBeDefined();
      expect(res.body.bookmark.page._id).toBe(page._id);
      expect(res.body.bookmark.page.path).toBe(page.path);
      expect(res.body.bookmark.user).toBe(userId);

      const Bookmark = crowi.model('Bookmark');
      const stored = await Bookmark.findOne({ page: page._id, user: userId });
      expect(stored).not.toBeNull();
    });

    it('returns { bookmark: null } when user has no grant on the page', async () => {
      const ownerCreate = await request(app)
        .post('/api/v2/pages')
        .set(authHeaders(accessToken))
        .send({ path: `${PATH_PREFIX}private`, body: '# secret', grant: 4 });
      expect(ownerCreate.status).toBe(200);
      const pageId = ownerCreate.body.page._id;

      const res = await request(app).post('/api/v2/bookmarks').set(authHeaders(otherAccessToken)).send({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.bookmark).toBeNull();
    });
  });

  describe('DELETE /api/v2/bookmarks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/api/v2/bookmarks').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when page_id is malformed', async () => {
      const res = await request(app).delete('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('removes an existing bookmark and returns { ok: true }', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}remove`, '# rm');
      const addRes = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(addRes.status).toBe(200);
      expect(addRes.body.bookmark).not.toBeNull();

      const res = await request(app).delete('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const Bookmark = crowi.model('Bookmark');
      const stored = await Bookmark.findOne({ page: page._id, user: userId });
      expect(stored).toBeNull();
    });

    it('returns { ok: true } even when no bookmark existed (legacy parity)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}remove-noop`, '# rm-noop');

      const res = await request(app).delete('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('GET /api/v2/bookmarks/me', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/bookmarks/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns the current user bookmarks paginated', async () => {
      const pageA = await createPageViaApi(accessToken, `${PATH_PREFIX}list-a`, '# a');
      const pageB = await createPageViaApi(accessToken, `${PATH_PREFIX}list-b`, '# b');
      await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: pageA._id });
      await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: pageB._id });

      const res = await request(app).get('/api/v2/bookmarks/me').set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.bookmarks.length).toBeGreaterThanOrEqual(2);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      const paths = res.body.bookmarks.map((b: { page: { path: string } }) => b.page.path);
      expect(paths).toContain(pageA.path);
      expect(paths).toContain(pageB.path);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
    });

    it('honors limit / offset and computes pager.next correctly', async () => {
      const pageA = await createPageViaApi(accessToken, `${PATH_PREFIX}page-a`, '# a');
      const pageB = await createPageViaApi(accessToken, `${PATH_PREFIX}page-b`, '# b');
      const pageC = await createPageViaApi(accessToken, `${PATH_PREFIX}page-c`, '# c');
      for (const p of [pageA, pageB, pageC]) {
        const addRes = await request(app).post('/api/v2/bookmarks').set(authHeaders(accessToken)).send({ page_id: p._id });
        expect(addRes.status).toBe(200);
      }

      const res = await request(app).get('/api/v2/bookmarks/me').set(authHeaders(accessToken)).query({ limit: 2, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.bookmarks).toHaveLength(2);
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      expect(res.body.pager.prev).toBeNull();
      expect(res.body.pager.next).toBe(2);
      expect(res.body.pager.offset).toBe(0);

      const second = await request(app).get('/api/v2/bookmarks/me').set(authHeaders(accessToken)).query({ limit: 2, offset: 2 });
      expect(second.status).toBe(200);
      expect(second.body.pager.prev).toBe(0);
      expect(second.body.pager.offset).toBe(2);
    });
  });
});
