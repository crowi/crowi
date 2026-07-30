import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `backlink` resource. The async `Backlink.createBySavedPage` chain
 * launched by the page-save event makes timing flaky, so we poll
 * until the expected backlink count lands before asserting on the
 * response shape.
 */

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Backlink = crowi.model('Backlink');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').lean();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([
    Page.deleteMany(filter),
    Revision.deleteMany(filter),
    Backlink.deleteMany({ $or: [{ page: { $in: pageIds } }, { fromPage: { $in: pageIds } }] }),
  ]);
};

const waitForBacklinkCount = async (pageId: string, expected: number, accessToken: string, maxTicks = 50) => {
  let last;
  for (let i = 0; i < maxTicks; i += 1) {
    const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: pageId, limit: 100 });
    last = res;
    if (res.status === 200 && res.body.backlinks?.length === expected) return res;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return last;
};

/**
 * Same polling shape as `waitForBacklinkCount`, but counts the raw
 * `Backlink` rows directly instead of the (now grant-filtered) API
 * response — needed by the grant-enforcement tests below, where the
 * caller doing the polling is deliberately *not* granted for one of the
 * `fromPage`s, so the API-visible count never reaches the raw count.
 */
const waitForRawBacklinkCount = async (pageId: string, expected: number, maxTicks = 50) => {
  const Backlink = crowi.model('Backlink');
  for (let i = 0; i < maxTicks; i += 1) {
    const count = await Backlink.countDocuments({ page: new Types.ObjectId(pageId) });
    if (count === expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('Routes /api/backlinks (Hono)', () => {
  const PATH_PREFIX = '/hono-backlink-test/';
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    const tester = await createTestUser({
      name: 'Backlink Test',
      username: 'honoBacklinkTester',
      email: 'hono-backlink-tester@example.com',
    });
    accessToken = tester.accessToken;
    userId = tester.user._id.toString();
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('GET /api/backlinks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/backlinks').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when page_id is not a valid ObjectId', async () => {
      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-existent page_id (SEC-BACKLINK-LEAK: target page must be granted to the caller)', async () => {
      const ghostId = new Types.ObjectId().toHexString();
      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: ghostId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns backlinks with fromPage / fromRevision.author / updatedAt', async () => {
      const target = await createPageViaApi(accessToken, `${PATH_PREFIX}target-basic`, '# target');
      const source = await createPageViaApi(accessToken, `${PATH_PREFIX}source-basic`, `link: <${target.path}>`);

      const res = await waitForBacklinkCount(target._id, 1, accessToken);

      expect(res.status).toBe(200);
      expect(res.body.hasNext).toBe(false);
      expect(res.body.backlinks).toHaveLength(1);

      const [b] = res.body.backlinks;
      expect(b._id).toBeDefined();
      expect(b.page).toBe(target._id);
      expect(b.fromPage._id).toBe(source._id);
      expect(b.fromPage.path).toBe(source.path);
      expect(b.fromRevision._id).toBe((source as { _id: string; path: string; revision: { _id: string } }).revision._id);
      expect(b.fromRevision.author).not.toBeNull();
      expect(b.fromRevision.author.username).toBe('honoBacklinkTester');
      expect(b.fromRevision.author._id).toBe(userId);
      expect(typeof b.updatedAt).toBe('string');
      expect(() => new Date(b.updatedAt).toISOString()).not.toThrow();
    });

    it('hasNext is false when there are exactly `limit` records', async () => {
      const target = await createPageViaApi(accessToken, `${PATH_PREFIX}target-exact`, '# target');
      await Promise.all([
        createPageViaApi(accessToken, `${PATH_PREFIX}src-exact-1`, `<${target.path}>`),
        createPageViaApi(accessToken, `${PATH_PREFIX}src-exact-2`, `<${target.path}>`),
        createPageViaApi(accessToken, `${PATH_PREFIX}src-exact-3`, `<${target.path}>`),
      ]);

      await waitForBacklinkCount(target._id, 3, accessToken);
      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 3 });

      expect(res.status).toBe(200);
      expect(res.body.backlinks).toHaveLength(3);
      expect(res.body.hasNext).toBe(false);
    });

    it('hasNext is true when there are more than `limit` records, and trims to `limit`', async () => {
      const target = await createPageViaApi(accessToken, `${PATH_PREFIX}target-more`, '# target');
      await Promise.all([
        createPageViaApi(accessToken, `${PATH_PREFIX}src-more-1`, `<${target.path}>`),
        createPageViaApi(accessToken, `${PATH_PREFIX}src-more-2`, `<${target.path}>`),
        createPageViaApi(accessToken, `${PATH_PREFIX}src-more-3`, `<${target.path}>`),
        createPageViaApi(accessToken, `${PATH_PREFIX}src-more-4`, `<${target.path}>`),
      ]);

      await waitForBacklinkCount(target._id, 4, accessToken);
      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.backlinks).toHaveLength(2);
      expect(res.body.hasNext).toBe(true);
    });
  });

  /**
   * SEC-BACKLINK-LEAK — grant enforcement on both the target `page_id`
   * and each `fromPage`. See `.feature-state/specs/feature-backlink-grant-enforcement.md`.
   */
  describe('GET /api/backlinks — grant enforcement (SEC-BACKLINK-LEAK)', () => {
    let otherToken: string;
    let otherId: string;

    beforeAll(async () => {
      const other = await createTestUser({
        name: 'Backlink Other',
        username: 'honoBacklinkOther',
        email: 'hono-backlink-other@example.com',
      });
      otherToken = other.accessToken;
      otherId = other.user._id.toString();
    });

    it('returns 404 (not 403) when the target page_id is not granted to the caller', async () => {
      const target = await createPageViaApi(otherToken, `${PATH_PREFIX}target-private`, '# secret', 4 /* GRANT_OWNER, granted to `other` only */);

      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('excludes fromPage entries the caller has no grant for, while keeping granted ones', async () => {
      const target = await createPageViaApi(accessToken, `${PATH_PREFIX}target-grant-filter`, '# target');
      const [visibleSource, hiddenSource] = await Promise.all([
        createPageViaApi(accessToken, `${PATH_PREFIX}src-grant-visible`, `<${target.path}>`),
        createPageViaApi(otherToken, `${PATH_PREFIX}src-grant-hidden`, `<${target.path}>`, 4 /* GRANT_OWNER, granted to `other` only */),
      ]);

      // Wait for both raw backlink rows to land (not the API-visible count,
      // which is deliberately 1 lower once grant filtering applies).
      await waitForRawBacklinkCount(target._id, 2);
      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 100 });

      expect(res.status).toBe(200);
      const fromPageIds = (res.body.backlinks as Array<{ fromPage: { _id: string } }>).map((b) => b.fromPage._id);
      expect(fromPageIds).toContain(visibleSource._id);
      expect(fromPageIds).not.toContain(hiddenSource._id);
      expect(res.body.hasNext).toBe(false);

      // Sanity check: `other` — who IS granted (creator + grantedUsers) —
      // still sees the same backlink, so this is a grant filter and not an
      // accidental blanket exclusion.
      const otherRes = await request(app).get('/api/backlinks').set(authHeaders(otherToken)).query({ page_id: target._id, limit: 100 });
      const otherFromPageIds = (otherRes.body.backlinks as Array<{ fromPage: { _id: string } }>).map((b) => b.fromPage._id);
      expect(otherFromPageIds).toContain(hiddenSource._id);
    });

    it('applies the draft filter and the grant filter together', async () => {
      const target = await createPageViaApi(accessToken, `${PATH_PREFIX}target-combined`, '# target');
      const source = await createPageViaApi(accessToken, `${PATH_PREFIX}src-combined`, `<${target.path}>`);
      await waitForBacklinkCount(target._id, 1, accessToken);

      // Flip the (already-linked) source into a hidden draft owned by
      // `other` AND a private (GRANT_OWNER, granted to `other` only) page.
      // Either filter alone would exclude it from the caller's view;
      // assert the combination still excludes it — i.e. neither filter
      // short-circuits past the other.
      const Page = crowi.model('Page');
      await Page.updateOne(
        { _id: source._id },
        { $set: { status: 'draft', creator: new Types.ObjectId(otherId), grant: 4, grantedUsers: [new Types.ObjectId(otherId)] } },
      );

      const res = await request(app).get('/api/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body.backlinks).toEqual([]);
      expect(res.body.hasNext).toBe(false);

      // The draft's author still sees it (draft filter passes for the
      // author) and is also grant-holder, so the backlink surfaces.
      const otherRes = await request(app).get('/api/backlinks').set(authHeaders(otherToken)).query({ page_id: target._id, limit: 100 });
      const otherFromPageIds = (otherRes.body.backlinks as Array<{ fromPage: { _id: string } }>).map((b) => b.fromPage._id);
      expect(otherFromPageIds).toContain(source._id);
    });
  });
});
