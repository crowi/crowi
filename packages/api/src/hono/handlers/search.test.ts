import request from 'supertest';
import type { SearchDriver, SearchHits, SearchQuery, SearchableDoc } from '@crowi/plugin-api';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser, createPageViaApi } from 'src/test/test-helpers';

/**
 * Compact wrapper for the `GET /api/search` request shape used in every
 * scenario below. Auth-less calls pass `null` for the token; query params
 * default to empty so 401 / validation tests can omit them.
 */
const search = (token: string | null, query: Record<string, string | number> = {}) => {
  const req = request(app).get('/api/search');
  if (token !== null) req.set(authHeaders(token));
  return req.query(query);
};

interface MockDriver extends SearchDriver {
  lastQuery: SearchQuery | null;
  nextResult: SearchHits;
}

const buildMockDriver = (initial: SearchHits = { total: 0, hits: [] }): MockDriver => {
  const driver: MockDriver = {
    lastQuery: null,
    nextResult: initial,
    async index(_doc: SearchableDoc) {
      // no-op
    },
    async remove(_id: string) {
      // no-op
    },
    async query(q: SearchQuery): Promise<SearchHits> {
      driver.lastQuery = q;
      return driver.nextResult;
    },
  };
  return driver;
};

/**
 * Swap the active search driver for the duration of the test. The test
 * harness boots Crowi with no crowi.config.json (so `active.search` is
 * null by default); we mutate the registry slot in place and restore it
 * afterwards so other test files see no leakage.
 */
const withMockDriver = async (driver: SearchDriver | null, fn: () => Promise<void>) => {
  if (!crowi.pluginRegistries) {
    throw new Error('pluginRegistries not initialized — Crowi.init() must run first');
  }
  const original = crowi.pluginRegistries.active.search;
  crowi.pluginRegistries.active.search = driver;
  try {
    await fn();
  } finally {
    crowi.pluginRegistries.active.search = original;
  }
};

describe('Routes /api/search (Hono)', () => {
  const PATH_PREFIX = '/hono-search-test/';
  let accessToken: string;
  let userId: string;
  let username: string;

  beforeAll(async () => {
    const owner = await createTestUser({
      name: 'Search Test',
      username: 'searchTester',
      email: 'search-tester@example.com',
    });
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();
    username = owner.user.username;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const Bookmark = crowi.model('Bookmark');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: unknown }) => p._id);
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter), Bookmark.deleteMany({ page: { $in: pageIds } })]);
  });

  describe('Authentication / validation', () => {
    it('returns 401 without auth', async () => {
      const res = await search(null, { q: 'foo' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when q is empty', async () => {
      await withMockDriver(buildMockDriver(), async () => {
        const res = await search(accessToken, { q: '' });
        expect(res.status).toBe(400);
      });
    });

    it('returns 400 when type is an invalid enum value', async () => {
      await withMockDriver(buildMockDriver(), async () => {
        const res = await search(accessToken, { q: 'foo', type: 'all' });
        expect(res.status).toBe(400);
      });
    });
  });

  describe('Search disabled (no driver registered)', () => {
    it('returns 503 SERVICE_UNAVAILABLE with feature=search', async () => {
      await withMockDriver(null, async () => {
        const res = await search(accessToken, { q: 'foo' });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(res.body.error.feature).toBe('search');
        expect(typeof res.body.error.message).toBe('string');
      });
    });
  });

  describe('Driver query forwarding', () => {
    it('forwards q / page / limit / pathPrefix and viewer to driver.query', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}forward`, '# forwarded');
      const driver = buildMockDriver({
        total: 1,
        hits: [{ id: page._id, path: page.path, snippet: '<mark>foo</mark> bar', score: 1.5 }],
      });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'foo', tree: '/team/eng/', page: 2, limit: 10 });

        expect(res.status).toBe(200);
        expect(driver.lastQuery).not.toBeNull();
        expect(driver.lastQuery?.q).toBe('foo');
        expect(driver.lastQuery?.pathPrefix).toBe('/team/eng/');
        expect(driver.lastQuery?.page).toBe(2);
        expect(driver.lastQuery?.limit).toBe(10);
        expect(driver.lastQuery?.viewer).toEqual({
          id: userId,
          username,
          isAdmin: false,
        });
        expect(driver.lastQuery?.grants).toBeUndefined();
      });
    });

    it('uses defaults page=1 / limit=50 when page/limit are omitted', async () => {
      const driver = buildMockDriver();
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'foo' });
        expect(res.status).toBe(200);
        expect(driver.lastQuery?.page).toBe(1);
        expect(driver.lastQuery?.limit).toBe(50);
      });
    });

    it.each(['portal', 'public', 'user'] as const)('forwards type=%s as grants.types: [type]', async (type) => {
      const driver = buildMockDriver();
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'foo', type });
        expect(res.status).toBe(200);
        expect(driver.lastQuery?.grants).toEqual({ types: [type] });
      });
    });

    it('reports isAdmin=true when the requesting user is admin', async () => {
      const adminUser = await createTestUser({
        name: 'Search Admin',
        username: 'searchAdmin',
        email: 'search-admin@example.com',
        admin: true,
      });
      const driver = buildMockDriver();
      await withMockDriver(driver, async () => {
        const res = await search(adminUser.accessToken, { q: 'foo' });
        expect(res.status).toBe(200);
        expect(driver.lastQuery?.viewer?.isAdmin).toBe(true);
      });
    });
  });

  describe('Successful response shape', () => {
    it('populates Page (path, creator) and joins Bookmark counts', async () => {
      const Bookmark = crowi.model('Bookmark');
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}hit-1`, '# hit');
      // Add a bookmark so the bulk count returns 1 for this page.
      const addRes = await request(app).post('/api/bookmarks').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(addRes.status).toBe(200);
      const expectedCount = await Bookmark.countByPageId(page._id);

      const driver = buildMockDriver({
        total: 1,
        hits: [{ id: page._id, path: page.path, snippet: '<mark>hit</mark>', score: 2.0 }],
        took: 17,
      });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'hit' });

        expect(res.status).toBe(200);
        expect(res.body.meta.total).toBe(1);
        expect(res.body.meta.results).toBe(1);
        expect(res.body.meta.took).toBe(17);
        expect(res.body.data).toHaveLength(1);

        const hit = res.body.data[0];
        expect(hit.pageId).toBe(page._id);
        expect(hit.path).toBe(page.path);
        expect(hit.score).toBe(2.0);
        // Snippet is forwarded verbatim — no escaping.
        expect(hit.snippet).toBe('<mark>hit</mark>');
        expect(hit.bookmarkCount).toBe(expectedCount);
        expect(hit.page._id).toBe(page._id);
        expect(hit.page.path).toBe(page.path);
        expect(hit.page.creator).not.toBeNull();
        expect(hit.page.creator.username).toBe(username);
      });
    });

    it('returns an empty data array (and skips Mongo) when the driver yields no hits', async () => {
      const driver = buildMockDriver({ total: 0, hits: [], took: 3 });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'no-match' });
        expect(res.status).toBe(200);
        expect(res.body.meta.total).toBe(0);
        expect(res.body.meta.results).toBe(0);
        expect(res.body.meta.took).toBe(3);
        expect(res.body.data).toEqual([]);
      });
    });

    it('drops hits whose Page document is missing (e.g. deleted between index and populate)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}hit-real`, '# real');
      const driver = buildMockDriver({
        total: 2,
        hits: [
          { id: page._id, path: page.path },
          // 24-hex but no matching Page doc
          { id: '0123456789abcdef01234567', path: '/missing' },
        ],
      });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'real' });
        expect(res.status).toBe(200);
        // total subtracts dropped hits (CROWI-SEC-REVIEW-003): the missing
        // doc was dropped, so the reported total shrinks with it.
        expect(res.body.meta.total).toBe(1);
        expect(res.body.meta.results).toBe(1);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].pageId).toBe(page._id);
      });
    });

    it('returns 500 INTERNAL_ERROR when the driver throws', async () => {
      const driver: SearchDriver = {
        async index() {},
        async remove() {},
        async query() {
          throw new Error('boom');
        },
      };
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'foo' });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
      });
    });
  });

  describe('Grant refilter (SEC-SEARCH-DELEGATED defense-in-depth)', () => {
    it('drops a hit for a page the viewer has no grant for, even though the driver returned it', async () => {
      const owner = await createTestUser({
        name: 'Search Refilter Owner',
        username: 'searchRefilterOwner',
        email: 'search-refilter-owner@example.com',
      });
      // grant 4 = GRANT_OWNER — only `owner` (and grantedUsers) can read it.
      const privatePage = await createPageViaApi(owner.accessToken, `${PATH_PREFIX}owner-only`, '# secret', 4);

      const driver = buildMockDriver({
        total: 1,
        hits: [{ id: privatePage._id, path: privatePage.path, snippet: '<mark>secret</mark>' }],
      });
      await withMockDriver(driver, async () => {
        // Search as `accessToken`'s user, who is NOT in grantedUsers for privatePage.
        const res = await search(accessToken, { q: 'secret' });
        expect(res.status).toBe(200);
        // total subtracts the refiltered hit (CROWI-SEC-REVIEW-003):
        // `data: []` with `total: 1` would be a private-page existence
        // oracle, so the dropped hit shrinks the total too.
        expect(res.body.meta.total).toBe(0);
        expect(res.body.meta.results).toBe(0);
        expect(res.body.data).toEqual([]);
      });
    });

    it('keeps a hit for a page the viewer does have a grant for', async () => {
      const owner = await createTestUser({
        name: 'Search Refilter Owner 2',
        username: 'searchRefilterOwner2',
        email: 'search-refilter-owner-2@example.com',
      });
      const privatePage = await createPageViaApi(owner.accessToken, `${PATH_PREFIX}owner-only-self`, '# secret', 4);

      const driver = buildMockDriver({
        total: 1,
        hits: [{ id: privatePage._id, path: privatePage.path, snippet: '<mark>secret</mark>' }],
      });
      await withMockDriver(driver, async () => {
        // Search as the owner themself — is in grantedUsers.
        const res = await search(owner.accessToken, { q: 'secret' });
        expect(res.status).toBe(200);
        expect(res.body.meta.total).toBe(1);
        expect(res.body.meta.results).toBe(1);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].pageId).toBe(privatePage._id);
      });
    });

    it('composes grant-refilter with missing-doc drop: only the visible+existing hit survives', async () => {
      const owner = await createTestUser({
        name: 'Search Refilter Owner 3',
        username: 'searchRefilterOwner3',
        email: 'search-refilter-owner-3@example.com',
      });
      const privatePage = await createPageViaApi(owner.accessToken, `${PATH_PREFIX}owner-only-mixed`, '# secret', 4);
      const publicPage = await createPageViaApi(accessToken, `${PATH_PREFIX}public-mixed`, '# secret too');

      const driver = buildMockDriver({
        total: 3,
        hits: [
          { id: privatePage._id, path: privatePage.path }, // no grant for accessToken's user
          { id: publicPage._id, path: publicPage.path }, // visible to everyone
          { id: '0123456789abcdef01234567', path: '/missing' }, // no backing doc
        ],
      });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'secret' });
        expect(res.status).toBe(200);
        // 2 of 3 hits dropped (ungranted + missing doc) -> total 3 - 2 = 1.
        expect(res.body.meta.total).toBe(1);
        expect(res.body.meta.results).toBe(1);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].pageId).toBe(publicPage._id);
      });
    });
  });

  // feature-restricted-grant-share-banner §7 — status / redirect hydration
  // boundary. Grant filtering (above) is populate-layer, pre-existing, and
  // uniform for admin/non-admin; this section is the NEW status/redirect
  // per-hit drop, which must be equally uniform (no admin bypass).
  describe('Status / redirect hydration boundary (feature-restricted-grant-share-banner §7)', () => {
    const setStatus = (pageId: string, status: string | null) => crowi.model('Page').updateOne({ _id: pageId }, { $set: { status } });

    it('regression pin: grant-refiltered hits never leak content (title/path/snippet/body) — pre-existing populate-layer behaviour, not new §7 code', async () => {
      const owner = await createTestUser({
        name: 'Search Status Grant Regression Owner',
        username: 'searchStatusGrantRegressionOwner',
        email: 'search-status-grant-regression-owner@example.com',
      });
      const page = await createPageViaApi(owner.accessToken, `${PATH_PREFIX}grant-regression`, '# secret grant-regression-marker', 2 /* GRANT_RESTRICTED */);

      const driver = buildMockDriver({
        total: 1,
        hits: [{ id: page._id, path: page.path, snippet: '<mark>grant-regression-marker</mark>' }],
      });
      await withMockDriver(driver, async () => {
        // `accessToken`'s user is not in grantedUsers for this page — stale
        // ES `granted_users` (if any) doesn't matter, populate drops it.
        const res = await search(accessToken, { q: 'grant-regression-marker' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(JSON.stringify(res.body)).not.toContain('grant-regression-marker');
      });
    });

    it('drops a redirect-stub hit for both admin and non-admin viewers', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}redirect-stub-status`, '# redirect-stub-marker');
      await crowi.model('Page').updateOne({ _id: page._id }, { $set: { redirectTo: '/somewhere-else' } });
      const admin = await createTestUser({
        name: 'Search Status Admin Redirect',
        username: 'searchStatusAdminRedirect',
        email: 'search-status-admin-redirect@example.com',
        admin: true,
      });

      for (const token of [accessToken, admin.accessToken]) {
        const driver = buildMockDriver({ total: 1, hits: [{ id: page._id, path: page.path }] });
        await withMockDriver(driver, async () => {
          const res = await search(token, { q: 'redirect-stub-marker' });
          expect(res.status).toBe(200);
          expect(res.body.data).toEqual([]);
        });
      }
    });

    it.each(['deleted', 'wip', 'deprecated'] as const)('drops a stale-indexed %s page for both admin and non-admin viewers', async (status) => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${status}-status`, `# ${status}-status-marker`);
      await setStatus(page._id, status);
      const admin = await createTestUser({
        name: `Search Status Admin ${status}`,
        username: `searchStatusAdmin${status}`,
        email: `search-status-admin-${status}@example.com`,
        admin: true,
      });

      for (const token of [accessToken, admin.accessToken]) {
        const driver = buildMockDriver({ total: 1, hits: [{ id: page._id, path: page.path }] });
        await withMockDriver(driver, async () => {
          const res = await search(token, { q: `${status}-status-marker` });
          expect(res.status).toBe(200);
          expect(res.body.data).toEqual([]);
        });
      }
    });

    it("keeps another user's draft out for both admin and non-admin viewers, but keeps the creator's own draft (list-visibility parity)", async () => {
      const draftOwner = await createTestUser({
        name: 'Search Status Draft Owner',
        username: 'searchStatusDraftOwner',
        email: 'search-status-draft-owner@example.com',
      });
      const page = await createPageViaApi(draftOwner.accessToken, `${PATH_PREFIX}draft-status`, '# draft-status-marker');
      await setStatus(page._id, 'draft');
      const admin = await createTestUser({
        name: 'Search Status Admin Draft',
        username: 'searchStatusAdminDraft',
        email: 'search-status-admin-draft@example.com',
        admin: true,
      });

      for (const token of [accessToken, admin.accessToken]) {
        const driver = buildMockDriver({ total: 1, hits: [{ id: page._id, path: page.path }] });
        await withMockDriver(driver, async () => {
          const res = await search(token, { q: 'draft-status-marker' });
          expect(res.status).toBe(200);
          expect(res.body.data).toEqual([]);
        });
      }

      const ownDriver = buildMockDriver({ total: 1, hits: [{ id: page._id, path: page.path }] });
      await withMockDriver(ownDriver, async () => {
        const res = await search(draftOwner.accessToken, { q: 'draft-status-marker' });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].pageId).toBe(page._id);
      });
    });

    it('does not over-filter: a normal published page and a granted GRANT_RESTRICTED page still appear', async () => {
      const publicPage = await createPageViaApi(accessToken, `${PATH_PREFIX}ok-published-public`, '# ok-published-marker');
      const restrictedPage = await createPageViaApi(accessToken, `${PATH_PREFIX}ok-published-restricted`, '# ok-restricted-marker', 2);

      const driver = buildMockDriver({
        total: 2,
        hits: [
          { id: publicPage._id, path: publicPage.path },
          { id: restrictedPage._id, path: restrictedPage.path },
        ],
      });
      await withMockDriver(driver, async () => {
        const res = await search(accessToken, { q: 'ok' });
        expect(res.status).toBe(200);
        const ids = (res.body.data as { pageId: string }[]).map((d) => d.pageId);
        expect(ids).toContain(publicPage._id);
        expect(ids).toContain(restrictedPage._id);
      });
    });
  });
});
