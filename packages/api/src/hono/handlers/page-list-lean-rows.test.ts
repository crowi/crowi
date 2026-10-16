import { Types } from 'mongoose';
import type { SearchDriver, SearchHits, SearchQuery, SearchableDoc } from '@crowi/plugin-api';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BASE = `/lean-${RUN}/`;
const BODY_MARKER = `LEAN-BODY-${RUN}`;
const OMITTED = ['body', 'meta', 'renderedAst', 'renderedAstArtifactKey'] as const;

interface Row {
  _id: string;
  path: string;
  revision?: string | Record<string, unknown>;
}

const wsHeaders = (token: string) => authHeaders(token);

const expectLeanRow = (row: Row | undefined, revisionId: string) => {
  expect(row).toBeDefined();
  const revision = row?.revision;
  expect(typeof revision).toBe('object');
  const rev = revision as Record<string, unknown>;
  expect(rev._id).toBe(revisionId);
  expect(typeof rev.path).toBe('string');
  expect(rev.contentType).toBe('markdown');
  expect(rev.author).toMatchObject({ username: expect.any(String) });
  for (const key of OMITTED) {
    expect(Object.hasOwn(rev, key)).toBe(false);
  }
};

const idsOf = (filter: unknown): string[] => {
  const ids = (filter as { _id?: { $in?: unknown[] } | unknown } | undefined)?._id;
  const list = (ids as { $in?: unknown[] } | undefined)?.$in ?? [ids];
  return list.map((v) => String(v));
};

/**
 * Records every Revision collection `find` issued while `fn` runs and
 * delegates to the real implementation, so the assertions see the actual
 * query options and the real results.
 */
const recordRevisionFinds = async (fn: () => Promise<void>) => {
  const Revision = crowi.model('Revision');
  const calls: Array<{ ids: string[]; projection: Record<string, number> | undefined }> = [];
  const original = Revision.collection.find.bind(Revision.collection);
  const spy = jest.spyOn(Revision.collection, 'find').mockImplementation(((filter: unknown, options?: { projection?: Record<string, number> }) => {
    calls.push({ ids: idsOf(filter), projection: options?.projection });
    return (original as (...args: unknown[]) => unknown)(filter, options);
  }) as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return calls;
};

const expectProjected = (calls: Array<{ ids: string[]; projection: Record<string, number> | undefined }>, revisionId: string) => {
  const hit = calls.filter((c) => c.ids.includes(revisionId));
  expect(hit.length).toBeGreaterThan(0);
  for (const c of hit) {
    expect(c.projection).toMatchObject({ body: 0, renderedAst: 0, meta: 0 });
  }
};

interface Driver extends SearchDriver {
  nextResult: SearchHits;
}
const buildDriver = (): Driver => {
  const driver: Driver = {
    nextResult: { total: 0, hits: [] },
    async index(_doc: SearchableDoc) {},
    async remove(_id: string) {},
    async query(_q: SearchQuery): Promise<SearchHits> {
      return driver.nextResult;
    },
  };
  return driver;
};

describe('page list lean rows', () => {
  let token: string;
  let username: string;
  let userId: string;
  let other: { token: string };
  let pageA: { _id: string; path: string };
  let revA: string;
  let portal: { _id: string; path: string };
  let revPortal: string;
  let trashed: { _id: string; path: string };
  let revTrashed: string;
  const emails: string[] = [];

  const revisionIdOf = async (pageId: string) => String((await crowi.model('Page').findById(pageId).lean())?.revision);

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Lean Owner', username: `lean${RUN}`, email: `lean-${RUN}@example.com` });
    emails.push(owner.user.email);
    token = owner.accessToken;
    username = owner.user.username;
    userId = String(owner.user._id);
    const second = await createTestUser({ name: 'Lean Other', username: `leano${RUN}`, email: `lean-o-${RUN}@example.com` });
    emails.push(second.user.email);
    other = { token: second.accessToken };

    const big = `# lean\n\n${BODY_MARKER}\n\n${'paragraph of text '.repeat(200)}`;
    portal = await createPageViaApi(token, BASE, `# portal\n\n${BODY_MARKER}-portal`);
    pageA = await createPageViaApi(token, `${BASE}a`, big);
    trashed = await createPageViaApi(token, `${BASE}gone`, big);
    revA = await revisionIdOf(pageA._id);
    revPortal = await revisionIdOf(portal._id);
    revTrashed = await revisionIdOf(trashed._id);
    const del = await request(app).delete('/api/pages').set(wsHeaders(token)).set('Idempotency-Key', `lean-${RUN}`).send({ page_id: trashed._id });
    expect(del.status).toBe(200);
    const bm = await request(app).post('/api/bookmarks').set(wsHeaders(token)).send({ page_id: pageA._id });
    expect(bm.status).toBe(200);
  });

  afterAll(async () => {
    const Page = crowi.model('Page');
    const ids = (
      await Page.find({ path: { $regex: `^(/trash)?${BASE}` } })
        .select('_id')
        .lean()
    ).map((p: { _id: unknown }) => p._id);
    await Promise.all([
      Page.deleteMany({ _id: { $in: ids } }),
      crowi.model('Revision').deleteMany({ path: { $regex: `^(/trash)?${BASE}` } }),
      crowi.model('Bookmark').deleteMany({ page: { $in: ids } }),
      crowi.model('User').deleteMany({ email: { $in: emails } }),
    ]);
  });

  describe('GET /pages/list (R-1)', () => {
    const find = (rows: Row[], id: string) => rows.find((r) => r._id === id);

    it.each([
      ['path', () => ({ path: BASE })],
      ['path_prefix', () => ({ path_prefix: BASE })],
      ['root', () => ({ limit: 100 })],
      ['creator', () => ({ user: userId })],
    ])('returns body-less revision rows for the %s branch', async (_name, buildQuery) => {
      const query = buildQuery();
      let res: request.Response | undefined;
      const calls = await recordRevisionFinds(async () => {
        res = await request(app).get('/api/pages/list').set(wsHeaders(token)).query(query);
      });
      expect(res?.status).toBe(200);
      expectLeanRow(find(res?.body.pages, pageA._id), revA);
      expectProjected(calls, revA);
      expect(JSON.stringify(res?.body.pages)).not.toContain(BODY_MARKER);
    });

    it('trash branch returns body-less rows', async () => {
      const calls = await recordRevisionFinds(async () => {
        const res = await request(app)
          .get('/api/pages/list')
          .set(wsHeaders(token))
          .query({ path: `/trash${BASE}`, include_deleted: 'true' });
        expect(res.status).toBe(200);
        expectLeanRow(find(res.body.pages, trashed._id), revTrashed);
      });
      expectProjected(calls, revTrashed);
    });

    it('keeps the portal page a full document while rows stay lean', async () => {
      let res: request.Response | undefined;
      const calls = await recordRevisionFinds(async () => {
        res = await request(app).get('/api/pages/list').set(wsHeaders(token)).query({ path: BASE });
      });
      expect(res?.status).toBe(200);
      expectLeanRow(find(res?.body.pages, pageA._id), revA);
      expect(res?.body.portalPage.revision._id).toBe(revPortal);
      expect(res?.body.portalPage.revision.body).toContain(`${BODY_MARKER}-portal`);
      expect(res?.body.portalPage.revision.renderedAst).toBeDefined();
      const portalCalls = calls.filter((c) => c.ids.includes(revPortal));
      expect(portalCalls.every((c) => c.projection?.body !== 0)).toBe(true);
      expectProjected(calls, revA);
    });

    it('serves a list and a detail read of the same page concurrently without mixing shapes', async () => {
      const [list, detail] = await Promise.all([
        request(app).get('/api/pages/list').set(wsHeaders(token)).query({ path: BASE }),
        request(app).get('/api/pages').set(wsHeaders(token)).query({ page_id: pageA._id }),
      ]);
      expectLeanRow(find(list.body.pages, pageA._id), revA);
      expect(detail.status).toBe(200);
      expect(detail.body.page.revision.body).toContain(BODY_MARKER);
      expect(detail.body.page.revision.meta).toBeDefined();
    });
  });

  describe('bookmarks and profile (R-2 to R-5, R-8)', () => {
    it('GET /bookmarks/me', async () => {
      const calls = await recordRevisionFinds(async () => {
        const res = await request(app).get('/api/bookmarks/me').set(wsHeaders(token));
        expect(res.status).toBe(200);
        const bookmark = res.body.bookmarks.find((b: { page: Row }) => b.page._id === pageA._id);
        expectLeanRow(bookmark?.page, revA);
      });
      expectProjected(calls, revA);
    });

    it('GET /user/:username carries lean recentPages and recentBookmarks', async () => {
      const calls = await recordRevisionFinds(async () => {
        const res = await request(app).get(`/api/user/${username}`).set(wsHeaders(token));
        expect(res.status).toBe(200);
        expectLeanRow(
          res.body.recentPages.find((p: Row) => p._id === pageA._id),
          revA,
        );
        const bookmark = res.body.recentBookmarks.find((b: { page: Row }) => b.page._id === pageA._id);
        expectLeanRow(bookmark?.page, revA);
        expect(JSON.stringify(res.body)).not.toContain(BODY_MARKER);
      });
      expectProjected(calls, revA);
    });

    it('GET /user/:username/pages', async () => {
      const calls = await recordRevisionFinds(async () => {
        const res = await request(app).get(`/api/user/${username}/pages`).set(wsHeaders(token));
        expect(res.status).toBe(200);
        expectLeanRow(
          res.body.pages.find((p: Row) => p._id === pageA._id),
          revA,
        );
      });
      expectProjected(calls, revA);
    });

    it('GET /user/:username/bookmarks', async () => {
      const calls = await recordRevisionFinds(async () => {
        const res = await request(app).get(`/api/user/${username}/bookmarks`).set(wsHeaders(other.token));
        expect(res.status).toBe(200);
        const bookmark = res.body.bookmarks.find((b: { page: Row }) => b.page._id === pageA._id);
        expectLeanRow(bookmark?.page, revA);
      });
      expectProjected(calls, revA);
    });

    it('GET /user/:username/subpages does not populate revisions and omits the revision', async () => {
      const userPage = await createPageViaApi(token, `/user/${username}/${RUN}-sub`, `# sub\n${BODY_MARKER}`);
      const subRev = await revisionIdOf(userPage._id);
      try {
        const calls = await recordRevisionFinds(async () => {
          const res = await request(app).get(`/api/user/${username}/subpages`).set(wsHeaders(token));
          expect(res.status).toBe(200);
          expect(JSON.stringify(res.body)).not.toContain(BODY_MARKER);
        });
        expect(calls.filter((c) => c.ids.includes(subRev))).toHaveLength(0);
      } finally {
        await crowi.model('Page').deleteMany({ _id: userPage._id });
        await crowi.model('Revision').deleteMany({ _id: subRev });
      }
    });
  });

  describe('search and recently viewed (R-6, R-7)', () => {
    it('GET /search returns lean page rows and keeps the snippet', async () => {
      const driver = buildDriver();
      driver.nextResult = { total: 1, hits: [{ id: pageA._id, path: pageA.path, snippet: '<mark>lean</mark>', score: 1 }] };
      const registry = crowi.pluginRegistries;
      if (!registry) throw new Error('pluginRegistries not initialized');
      const original = registry.active.search;
      registry.active.search = driver;
      try {
        const calls = await recordRevisionFinds(async () => {
          const res = await request(app).get('/api/search').set(wsHeaders(token)).query({ q: 'lean' });
          expect(res.status).toBe(200);
          const hit = res.body.data.find((h: { pageId: string }) => h.pageId === pageA._id);
          expect(hit.snippet).toBe('<mark>lean</mark>');
          expectLeanRow(hit.page, revA);
        });
        expectProjected(calls, revA);
      } finally {
        registry.active.search = original;
      }
    });

    it('GET /me/recently-viewed-pages returns lean rows', async () => {
      const lru = jest.spyOn(crowi.lru, 'get').mockResolvedValueOnce([pageA._id]);
      try {
        const calls = await recordRevisionFinds(async () => {
          const res = await request(app).get('/api/me/recently-viewed-pages').set(wsHeaders(token));
          expect(res.status).toBe(200);
          expectLeanRow(
            res.body.pages.find((p: Row) => p._id === pageA._id),
            revA,
          );
        });
        expectProjected(calls, revA);
      } finally {
        lru.mockRestore();
      }
    });
  });

  it('keeps the stored revision body intact', async () => {
    const stored = await crowi.model('Revision').findById(new Types.ObjectId(revA));
    expect(stored?.body).toContain(BODY_MARKER);
  });
});
