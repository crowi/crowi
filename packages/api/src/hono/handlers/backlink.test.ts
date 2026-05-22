import { Types } from 'mongoose';
import request from 'supertest';

import { Fixture, app, crowi } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `backlink` resource. The async `Backlink.createBySavedPage` chain
 * launched by the page-save event makes timing flaky, so we poll
 * until the expected backlink count lands before asserting on the
 * response shape.
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

const createPageViaApi = async (accessToken: string, path: string, body: string) => {
  const res = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path, body });
  if (res.status !== 200) {
    throw new Error(`Failed to seed page (${path}): ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.page as { _id: string; path: string; revision: { _id: string } };
};

const waitForBacklinkCount = async (pageId: string, expected: number, accessToken: string, maxTicks = 50) => {
  let last;
  for (let i = 0; i < maxTicks; i += 1) {
    const res = await request(app).get('/api/v2/backlinks').set(authHeaders(accessToken)).query({ page_id: pageId, limit: 100 });
    last = res;
    if (res.status === 200 && res.body.backlinks?.length === expected) return res;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return last;
};

describe('Routes /api/v2/backlinks (Hono)', () => {
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

  describe('GET /api/v2/backlinks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/backlinks').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when page_id is not a valid ObjectId', async () => {
      const res = await request(app).get('/api/v2/backlinks').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
    });

    it('returns 200 with empty backlinks list for a non-existent page_id', async () => {
      const ghostId = new Types.ObjectId().toHexString();
      const res = await request(app).get('/api/v2/backlinks').set(authHeaders(accessToken)).query({ page_id: ghostId });
      expect(res.status).toBe(200);
      expect(res.body.backlinks).toEqual([]);
      expect(res.body.hasNext).toBe(false);
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
      expect(b.fromRevision._id).toBe(source.revision._id);
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
      const res = await request(app).get('/api/v2/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 3 });

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
      const res = await request(app).get('/api/v2/backlinks').set(authHeaders(accessToken)).query({ page_id: target._id, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.backlinks).toHaveLength(2);
      expect(res.body.hasNext).toBe(true);
    });
  });
});
