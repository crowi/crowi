import request from 'supertest';
import { Types } from 'mongoose';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

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

const cleanupPathPrefix = (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const filter = { path: { $regex: `^${prefix}` } };
  return Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
};

describe('Routes /api/v2/pages/.../revisions (ts-rest)', () => {
  const PATH_PREFIX = '/ts-rest-revision-test/';
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'Revision Tester', username: 'revisionTester', email: 'revision-tester@example.com' }),
      createTestUser({ name: 'Revision Other', username: 'revisionOther', email: 'revision-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  /** Create a page (and capture its first revision) using the ts-rest createPage endpoint. */
  const createTestPage = async (path: string, body = '# initial', grant?: number) => {
    const headers = authHeaders(accessToken);
    const payload: { path: string; body: string; grant?: number } = { path, body };
    if (grant !== undefined) payload.grant = grant;
    const res = await request(app).post('/api/v2/pages').set(headers).send(payload);
    expect(res.status).toBe(200);
    return {
      pageId: res.body.page._id as string,
      revisionId: res.body.page.revision._id as string,
      path,
    };
  };

  /** Append a new revision to an existing page so we can test list ordering. */
  const updateTestPage = async (pageId: string, body: string) => {
    const res = await request(app).put('/api/v2/pages').set(authHeaders(accessToken)).send({ page_id: pageId, body });
    expect(res.status).toBe(200);
    return res.body.page.revision._id as string;
  };

  describe('GET /api/v2/pages/:page_id/revisions', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/v2/pages/000000000000000000000000/revisions').set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_REQUEST when page_id is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/not-an-objectid/revisions').set(authHeaders(accessToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 PAGE_NOT_FOUND for a non-existent page_id', async () => {
      const res = await request(app).get(`/api/v2/pages/${new Types.ObjectId().toString()}/revisions`).set(authHeaders(accessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller has no grant', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}private`, '# private', 4);

      const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set(authHeaders(otherAccessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 200 with revisions in createdAt desc order and excludes body', async () => {
      const { pageId, revisionId: firstRevisionId } = await createTestPage(`${PATH_PREFIX}list-order`, '# v1');
      const secondRevisionId = await updateTestPage(pageId, '# v2');
      const thirdRevisionId = await updateTestPage(pageId, '# v3');

      const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revisions).toHaveLength(3);

      const ids = res.body.revisions.map((r: { _id: string }) => r._id);
      expect(ids).toEqual([thirdRevisionId, secondRevisionId, firstRevisionId]);

      // Body must not be included in the meta list response.
      for (const r of res.body.revisions) {
        expect(r.body).toBeUndefined();
        expect(r.path).toBe(`${PATH_PREFIX}list-order`);
        expect(r.author.username).toBe('revisionTester');
      }

      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
    });

    it('honors limit and offset and returns pager.next when more exist', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}paged`, '# v1');
      await updateTestPage(pageId, '# v2');
      await updateTestPage(pageId, '# v3');

      const first = await request(app).get(`/api/v2/pages/${pageId}/revisions`).query({ limit: 2, offset: 0 }).set(authHeaders(accessToken));

      expect(first.status).toBe(200);
      expect(first.body.revisions).toHaveLength(2);
      expect(first.body.pager).toEqual({ prev: null, next: 2, offset: 0 });

      const second = await request(app).get(`/api/v2/pages/${pageId}/revisions`).query({ limit: 2, offset: 2 }).set(authHeaders(accessToken));

      expect(second.status).toBe(200);
      expect(second.body.revisions).toHaveLength(1);
      expect(second.body.pager).toEqual({ prev: 0, next: null, offset: 2 });
    });
  });

  describe('GET /api/v2/pages/revisions/:id', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/v2/pages/revisions/000000000000000000000000').set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_REQUEST for malformed id', async () => {
      const res = await request(app).get('/api/v2/pages/revisions/bad-id').set(authHeaders(accessToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 PAGE_NOT_FOUND for a non-existent id', async () => {
      const res = await request(app).get(`/api/v2/pages/revisions/${new Types.ObjectId().toString()}`).set(authHeaders(accessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 200 with the revision body and populated author', async () => {
      const { revisionId, path } = await createTestPage(`${PATH_PREFIX}detail`, '# the body');

      const res = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revision).toBeDefined();
      expect(res.body.revision._id).toBe(revisionId);
      expect(res.body.revision.path).toBe(path);
      expect(res.body.revision.body).toBe('# the body');
      expect(res.body.revision.author.username).toBe('revisionTester');
    });

    it('returns 404 PAGE_NOT_FOUND when caller has no grant on the revisions page', async () => {
      const { revisionId } = await createTestPage(`${PATH_PREFIX}detail-private`, '# private', 4);

      const res = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(otherAccessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });

  describe('GET /api/v2/pages/revisions?ids=...', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/v2/pages/revisions').query({ ids: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_REQUEST when an id is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/revisions').query({ ids: 'not-an-objectid' }).set(authHeaders(accessToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 INVALID_REQUEST when more than 10 ids are given', async () => {
      const ids = Array.from({ length: 11 }, () => new Types.ObjectId().toString()).join(',');
      const res = await request(app).get('/api/v2/pages/revisions').query({ ids }).set(authHeaders(accessToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 200 with both revisions when 2 ids of the same path are given', async () => {
      const { pageId, revisionId: r1 } = await createTestPage(`${PATH_PREFIX}pair`, '# v1');
      const r2 = await updateTestPage(pageId, '# v2');

      const res = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revisions).toHaveLength(2);
      const bodies = res.body.revisions.map((r: { body: string }) => r.body).sort();
      expect(bodies).toEqual(['# v1', '# v2']);
    });

    it('returns 400 INVALID_REQUEST when revisions span different paths', async () => {
      const { revisionId: r1 } = await createTestPage(`${PATH_PREFIX}mix-a`, '# a');
      const { revisionId: r2 } = await createTestPage(`${PATH_PREFIX}mix-b`, '# b');

      const res = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(accessToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 PAGE_NOT_FOUND when caller has no grant on the shared path', async () => {
      const { pageId, revisionId: r1 } = await createTestPage(`${PATH_PREFIX}pair-private`, '# v1', 4);
      const r2 = await updateTestPage(pageId, '# v2');

      const res = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(otherAccessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });
});
