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

  // DC-5: force the cosmetic `revision.path` rename-sync step to throw
  // mid-rename (same technique as `page-lifecycle-epoch.test.ts`'s AC-30
  // coverage). The page's own path write already lands durably before this
  // step, so the page moves to `newPath` in the DB while `revision.path` is
  // left stale, still reading the pre-rename value — the discriminating
  // setup the AC-3/AC-4/AC-5 "grant/history survives a failed path-sync"
  // tests below rely on.
  const renameWithFailedPathSync = async (page: unknown, newPath: string, user: unknown): Promise<void> => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const spy = jest.spyOn(Revision, 'updateRevisionListByPath').mockImplementationOnce(async () => {
      throw new Error('simulated revision-path rewrite failure');
    });
    try {
      await expect(Page.rename(page, newPath, user, {})).rejects.toThrow('simulated revision-path rewrite failure');
    } finally {
      spy.mockRestore();
    }
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

    it('AC-4/AC-5: still lists a pre-rename revision by page id even when the cosmetic path-sync step fails', async () => {
      const Page = crowi.model('Page');
      const user = await crowi.model('User').findOne({ username: 'honoRevisionTester' });

      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}rename-sync-fail`, '# v1');
      const page = await Page.findById(pageId);
      await renameWithFailedPathSync(page, `${PATH_PREFIX}rename-sync-fail-2`, user);

      // AC-4: `listRevisions` resolves by the immutable `page` id (the URL
      // param), never by `path` — the revision is found despite its
      // on-disk `path` still reading the pre-rename value.
      const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.revisions.map((r: { _id: string }) => r._id)).toEqual([revisionId]);
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
        // DC-5: a real collab-flow save always goes through `prepareRevision`
        // and gets `page` stamped — set it explicitly here since this test
        // inserts the Revision document directly instead of driving the
        // collab save flow.
        page: page._id,
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

    it('AC-3: resolves the CURRENT (renamed) page via revision.page, not a path reverse-lookup', async () => {
      const Page = crowi.model('Page');
      const user = await crowi.model('User').findOne({ username: 'honoRevisionTester' });

      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}detail-rename-old`, '# pre-rename body');
      const page = await Page.findById(pageId);
      await Page.rename(page, `${PATH_PREFIX}detail-rename-new`, user, {});

      const res = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.revision._id).toBe(revisionId);
      // The wire `path` field still mirrors the (synced) current path —
      // AC-6 preserves it for display, even though resolution no longer
      // depends on it.
      expect(res.body.revision.path).toBe(`${PATH_PREFIX}detail-rename-new`);
    });

    it('AC-3 (fix): does not leak a deleted page’s private revision through a path a different page later reused', async () => {
      const Page = crowi.model('Page');
      const Revision = crowi.model('Revision');

      // Page A: owner-only (grant 4), so only its creator (accessToken
      // user) can read it. Hard-delete it WITHOUT going through
      // `Page.removePage` (simulating a revision left orphaned by a
      // standard-lifecycle deviation — the same class this feature's
      // migration reports, see `revision-page-ref-backfill`) so its
      // revision survives with a stale `path`/`page` pointing at the now-
      // gone page A.
      const { pageId: pageAId, revisionId: revisionAId, path } = await createTestPage(`${PATH_PREFIX}reuse-path`, '# private A', 4);
      await Page.deleteOne({ _id: pageAId });

      // Page B: a completely unrelated PUBLIC page later created at the
      // SAME path. Pre-fix, `getRevisionRoute` resolved the owning page by
      // reverse `path` lookup — it would have matched page B here and let
      // ANY caller (including `otherAccessToken`, never granted on A) read
      // A's private revision body through B's public grant.
      await createTestPage(path, '# public B');
      const revisionA = await Revision.findById(revisionAId).lean();
      expect(revisionA.page?.toString()).toBe(pageAId);

      const asOwner = await request(app).get(`/api/v2/pages/revisions/${revisionAId}`).set(authHeaders(accessToken));
      const asStranger = await request(app).get(`/api/v2/pages/revisions/${revisionAId}`).set(authHeaders(otherAccessToken));

      // Both fail closed — page A is gone, so `revision.page` resolves to
      // nothing. Neither caller can read A's revision through B's grant.
      expect(asOwner.status).toBe(404);
      expect(asOwner.body.error.code).toBe('PAGE_NOT_FOUND');
      expect(asStranger.status).toBe(404);
      expect(asStranger.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('AC-3/AC-5: grant survives a FAILED rename path-sync even when a different PUBLIC page later reuses the stale path', async () => {
      const Page = crowi.model('Page');
      const user = await crowi.model('User').findOne({ username: 'honoRevisionTester' });

      // Owner-only (grant 4) — only its creator (`accessToken`) is granted.
      const oldPath = `${PATH_PREFIX}sync-fail-reuse-old`;
      const { pageId, revisionId } = await createTestPage(oldPath, '# private body', 4);
      const page = await Page.findById(pageId);

      // This is the discriminating setup a plain rename (path sync
      // succeeds) can't provide: with a successful sync, a
      // `path`-reverse-lookup implementation would *also* resolve the
      // correct current page, masking the bug this feature fixes.
      await renameWithFailedPathSync(page, `${PATH_PREFIX}sync-fail-reuse-new`, user);

      // A different, unrelated PUBLIC page is created later by a different
      // user at the now-free stale `oldPath`. A `path`-reverse-lookup
      // implementation would resolve the stale `revision.path` to THIS
      // page and grant access via its PUBLIC grant — precisely the
      // grant-leak this feature closes.
      await request(app)
        .post('/api/v2/pages')
        .set(authHeaders(otherAccessToken))
        .send({ path: oldPath, body: '# unrelated public body', grant: 1 })
        .expect(200);

      // Stranger: granted on the NEW public page occupying the reused
      // path, but never granted on the ORIGINAL (still owner-only) page —
      // must be denied.
      const asStranger = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(otherAccessToken));
      expect(asStranger.status).toBe(404);
      expect(asStranger.body.error.code).toBe('PAGE_NOT_FOUND');

      // Owner: still granted on the original page (now living at the new
      // path) despite the failed path-sync — AC-5, history is never lost
      // even though the wire `path` field on this revision still reads
      // stale.
      const asOwner = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken));
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.revision._id).toBe(revisionId);
      expect(asOwner.body.revision.body).toBe('# private body');
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

    it('AC-3: resolves the shared CURRENT (renamed) page via revision.page across both ids', async () => {
      const Page = crowi.model('Page');
      const user = await crowi.model('User').findOne({ username: 'honoRevisionTester' });

      const { pageId, revisionId: r1 } = await createTestPage(`${PATH_PREFIX}pair-rename-old`, '# v1');
      const r2 = await updateTestPage(pageId, '# v2');
      const page = await Page.findById(pageId);
      await Page.rename(page, `${PATH_PREFIX}pair-rename-new`, user, {});

      const res = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.revisions).toHaveLength(2);
    });

    it('AC-3/AC-5 (shared): grant survives a FAILED rename path-sync even when a different PUBLIC page later reuses the stale path', async () => {
      const Page = crowi.model('Page');
      const user = await crowi.model('User').findOne({ username: 'honoRevisionTester' });

      // Owner-only (grant 4) — only its creator (`accessToken`) is granted.
      const oldPath = `${PATH_PREFIX}pair-sync-fail-reuse-old`;
      const { pageId, revisionId: r1 } = await createTestPage(oldPath, '# v1', 4);
      const r2 = await updateTestPage(pageId, '# v2');
      const page = await Page.findById(pageId);

      // See the singular-`:id` sibling test above for why a plain
      // (sync-succeeds) rename can't discriminate a page-id-based
      // implementation from a `path`-reverse-lookup one.
      await renameWithFailedPathSync(page, `${PATH_PREFIX}pair-sync-fail-reuse-new`, user);

      // A different, unrelated PUBLIC page is created later by a different
      // user at the now-free stale `oldPath`.
      await request(app)
        .post('/api/v2/pages')
        .set(authHeaders(otherAccessToken))
        .send({ path: oldPath, body: '# unrelated public body', grant: 1 })
        .expect(200);

      // Stranger: granted on the NEW public page occupying the reused
      // path, but never granted on the ORIGINAL (still owner-only) page —
      // must be denied for the whole shared-ids request.
      const asStranger = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(otherAccessToken));
      expect(asStranger.status).toBe(404);
      expect(asStranger.body.error.code).toBe('PAGE_NOT_FOUND');

      // Owner: still granted on the original page (now living at the new
      // path) despite the failed path-sync — AC-5, both revisions remain
      // visible via their immutable `page` id.
      const asOwner = await request(app)
        .get('/api/v2/pages/revisions')
        .query({ ids: `${r1},${r2}` })
        .set(authHeaders(accessToken));
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.revisions).toHaveLength(2);
    });
  });
});
