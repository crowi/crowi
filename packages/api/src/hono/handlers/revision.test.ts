import { Types } from 'mongoose';
import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `revision` resource. Exercises the literal-vs-template ordering
 * (`/pages/revisions` must beat `/pages/revisions/{id}` for the
 * `?ids=...` list form), the grant + existence-leak guards, and the
 * Phase 8 `savedBy` / `contributors` surfacing for collab-flow
 * checkpoints.
 */

const cleanupPathPrefix = (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const filter = { path: { $regex: `^${prefix}` } };
  return Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
};

describe('Routes /api/v2/pages/.../revisions (Hono)', () => {
  const PATH_PREFIX = '/hono-revision-test/';
  let accessToken: string;
  let accessTokenUserId: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const [{ accessToken: token, user }, { accessToken: otherToken }] = await Promise.all([
      createTestUser({ name: 'Revision Tester', username: 'honoRevisionTester', email: 'hono-revision-tester@example.com' }),
      createTestUser({ name: 'Revision Other', username: 'honoRevisionOther', email: 'hono-revision-other@example.com' }),
    ]);
    accessToken = token;
    accessTokenUserId = user._id.toString();
    otherAccessToken = otherToken;
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

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

      for (const r of res.body.revisions) {
        expect(r.body).toBeUndefined();
        expect(r.path).toBe(`${PATH_PREFIX}list-order`);
        expect(r.author.username).toBe('honoRevisionTester');
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

    it('omits savedBy/contributors for revisions without collab metadata (v1.x fallback)', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}v1x`, '# legacy');

      const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revisions).toHaveLength(1);
      expect(res.body.revisions[0].author).toBeDefined();
      expect(res.body.revisions[0].author.username).toBe('honoRevisionTester');
      expect(res.body.revisions[0].savedBy).toBeUndefined();
      expect(res.body.revisions[0].contributors).toBeUndefined();
    });

    it('surfaces savedBy + contributors when present on the Revision document', async () => {
      const Page = crowi.model('Page');
      const Revision = crowi.model('Revision');
      const User = crowi.model('User');

      const savedByUser = await User.findOne({ username: 'honoRevisionTester' });
      const peerUser = await User.findOne({ username: 'honoRevisionOther' });
      expect(savedByUser).not.toBeNull();
      expect(peerUser).not.toBeNull();

      const { pageId } = await createTestPage(`${PATH_PREFIX}collab-checkpoint`, '# v1');
      const page = await Page.findById(pageId);
      expect(page).not.toBeNull();

      await Revision.create({
        path: page.path,
        body: '# v2 collab',
        format: 'markdown',
        author: savedByUser._id,
        savedBy: savedByUser._id,
        contributors: [peerUser._id],
      });

      const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revisions.length).toBeGreaterThanOrEqual(2);

      const collabRev = res.body.revisions[0];
      expect(collabRev.savedBy).toBeDefined();
      expect(collabRev.savedBy.username).toBe('honoRevisionTester');
      expect(Array.isArray(collabRev.contributors)).toBe(true);
      expect(collabRev.contributors).toHaveLength(1);
      expect(collabRev.contributors[0].username).toBe('honoRevisionOther');

      const legacyRev = res.body.revisions[1];
      expect(legacyRev.savedBy).toBeUndefined();
      expect(legacyRev.contributors).toBeUndefined();
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
      expect(res.body.revision.author.username).toBe('honoRevisionTester');
    });

    it('returns 404 PAGE_NOT_FOUND when caller has no grant on the revisions page', async () => {
      const { revisionId } = await createTestPage(`${PATH_PREFIX}detail-private`, '# private', 4);

      const res = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(otherAccessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    // feature-plugin-renderer-mermaid spec §6 — same actor-wiring proof as
    // `page.test.ts`'s "Hono getPage — actor wiring" describe, for this
    // handler's own `computeRevisionRenderArtifactsAsync` call site
    // (`revision.ts:237-244`).
    it('passes actor: { kind: "user", userId } — the authenticated caller — to computeRevisionRenderArtifactsAsync', async () => {
      const { revisionId } = await createTestPage(`${PATH_PREFIX}actor-wiring`, '# body');

      const pageResponseModule = await import('src/util/page-response');
      const spy = jest.spyOn(pageResponseModule, 'computeRevisionRenderArtifactsAsync');
      try {
        const res = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken));

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalled();
        // computeRevisionRenderArtifactsAsync(crowi, storedMeta, storedAst, body, actor, storedRendererVersion?, pageId?)
        const actorArg = spy.mock.calls[0]?.[4];
        expect(actorArg).toEqual({ kind: 'user', userId: accessTokenUserId });
      } finally {
        spy.mockRestore();
      }
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
