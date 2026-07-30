import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `comment` resource. The Hono port preserves the legacy 4xx
 * envelopes byte-for-byte (`PAGE_NOT_FOUND` / `PAGE_NOT_GRANTED` /
 * `COMMENT_NOT_FOUND` / `INVALID_REQUEST`), and the commentCount
 * post-save hook on the Comment model is exercised end-to-end.
 */

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Comment = crowi.model('Comment');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').exec();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([Comment.deleteMany({ page: { $in: pageIds } }), Page.deleteMany(filter), Revision.deleteMany(filter)]);
};

describe('Routes /api/comments (Hono)', () => {
  const PATH_PREFIX = '/hono-comment-test/';
  let Page: ReturnType<typeof crowi.model>;
  let Comment: ReturnType<typeof crowi.model>;
  let Watcher: ReturnType<typeof crowi.model>;
  let accessToken: string;
  let otherAccessToken: string;
  let otherUserId: Types.ObjectId;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Comment = crowi.model('Comment');
    Watcher = crowi.model('Watcher');

    const [tester, other] = await Promise.all([
      createTestUser({ name: 'Comment Tester', username: 'honoCommentTester', email: 'hono-comment-tester@example.com' }),
      createTestUser({ name: 'Comment Other', username: 'honoCommentOther', email: 'hono-comment-other@example.com' }),
    ]);
    accessToken = tester.accessToken;
    otherAccessToken = other.accessToken;
    otherUserId = other.user._id;
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    await Watcher.deleteMany({});
  });

  const createTestPage = async (path: string, body = '# initial', grant?: number) => {
    const headers = authHeaders(accessToken);
    const payload: { path: string; body: string; grant?: number } = { path, body };
    if (grant !== undefined) payload.grant = grant;
    const res = await request(app).post('/api/pages').set(headers).send(payload);
    expect(res.status).toBe(200);
    return {
      pageId: res.body.page._id as string,
      revisionId: res.body.page.revision._id as string,
      path,
    };
  };

  describe('GET /api/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/comments').query({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when neither page_id nor revision_id is provided', async () => {
      const res = await request(app).get('/api/comments').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 200 with empty array for a page that has no comments', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}empty`);
      const res = await request(app).get('/api/comments').query({ page_id: pageId }).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.comments).toEqual([]);
    });

    it('returns 200 with comments after they are added', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}with-comments`);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'first comment' });
      expect(addRes.status).toBe(200);

      const listRes = await request(app).get('/api/comments').query({ page_id: pageId }).set(headers);
      expect(listRes.status).toBe(200);
      expect(listRes.body.comments).toHaveLength(1);
      expect(listRes.body.comments[0].comment).toBe('first comment');
      expect(listRes.body.comments[0].creator.username).toBe('honoCommentTester');
      expect(listRes.body.comments[0].revision).toBe(revisionId);
    });

    it('grant-checks the page: owner can list, others get 404 (crowi-review CLS-003)', async () => {
      // Owner-only page (grant 4) with a comment.
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}private-list`, '# private', 4);
      const addRes = await request(app)
        .post('/api/comments')
        .set(authHeaders(accessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'secret comment' });
      expect(addRes.status).toBe(200);

      // The owner can still read the comments.
      const ownerRes = await request(app).get('/api/comments').query({ page_id: pageId }).set(authHeaders(accessToken));
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.comments).toHaveLength(1);

      // A non-granted user cannot — 404 hides existence (not 200 with bodies).
      const otherRes = await request(app).get('/api/comments').query({ page_id: pageId }).set(authHeaders(otherAccessToken));
      expect(otherRes.status).toBe(404);
      expect(otherRes.body.error.code).toBe('PAGE_NOT_FOUND');

      // Same boundary via revision_id.
      const otherByRev = await request(app).get('/api/comments').query({ revision_id: revisionId }).set(authHeaders(otherAccessToken));
      expect(otherByRev.status).toBe(404);
      expect(otherByRev.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('DC-5 (`feature-revision-page-ref`) regression: revision_id lookup does not leak a deleted private page’s comment through a path a different page later reused', async () => {
      // Page A: owner-only (grant 4) with a comment. Hard-deleted directly
      // (bypassing `Page.removePage`) so its revision + comment survive —
      // the same standard-lifecycle-deviation shape covered by
      // `revision-page-ref-backfill`'s orphan handling.
      const { pageId: pageAId, revisionId: revisionAId, path } = await createTestPage(`${PATH_PREFIX}reuse-path`, '# private A', 4);
      const addRes = await request(app)
        .post('/api/comments')
        .set(authHeaders(accessToken))
        .send({ page_id: pageAId, revision_id: revisionAId, comment: 'secret comment on A' });
      expect(addRes.status).toBe(200);
      await Page.deleteOne({ _id: pageAId });

      // Page B: an unrelated PUBLIC page later created at the SAME path.
      // Pre-fix, `listComments`'s revision_id branch resolved the owning
      // page via `Page.findOne({ path: revision.path })` — it would have
      // matched page B here and let ANY caller read A's private comment
      // through B's public grant.
      await createTestPage(path, '# public B');

      const asOwner = await request(app).get('/api/comments').query({ revision_id: revisionAId }).set(authHeaders(accessToken));
      const asStranger = await request(app).get('/api/comments').query({ revision_id: revisionAId }).set(authHeaders(otherAccessToken));

      // Both fail closed — page A is gone, so `revision.page` resolves to
      // nothing. Neither caller can read A's comment through B's grant.
      expect(asOwner.status).toBe(404);
      expect(asOwner.body.error.code).toBe('PAGE_NOT_FOUND');
      expect(asStranger.status).toBe(404);
      expect(asStranger.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });

  describe('POST /api/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/comments')
        .send({ page_id: '000000000000000000000000', revision_id: '000000000000000000000000', comment: 'x' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('creates a comment and increments Page.commentCount via post-save hook', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}post-basic`);
      const headers = authHeaders(accessToken);

      const res = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'hello world' });

      expect(res.status).toBe(200);
      expect(res.body.comment).toBeDefined();
      expect(res.body.comment.comment).toBe('hello world');
      expect(res.body.comment.creator.username).toBe('honoCommentTester');
      expect(res.body.comment.page).toBe(pageId);
      expect(res.body.comment.revision).toBe(revisionId);

      let pageDoc: { commentCount: number } | null = null;
      for (let i = 0; i < 10; i += 1) {
        pageDoc = await Page.findById(pageId).exec();
        if (pageDoc && pageDoc.commentCount === 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pageDoc).not.toBeNull();
      expect(pageDoc?.commentCount).toBe(1);
    });

    it('returns 404 PAGE_NOT_FOUND when caller has no grant on the target page', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}private`, '# private', 4);

      const res = await request(app)
        .post('/api/comments')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'sneaky' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
      expect(await Comment.countDocuments({ page: new Types.ObjectId(pageId) })).toBe(0);
    });

    it('returns 400 INVALID_REQUEST when page_id is malformed', async () => {
      const res = await request(app)
        .post('/api/comments')
        .set(authHeaders(accessToken))
        .send({ page_id: 'not-an-objectid', revision_id: '000000000000000000000000', comment: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });
  });

  // feature-watch-autosubscribe — commenting auto-creates a WATCH watcher
  // row for the commenter, surfaced synchronously via `newlyWatching`.
  describe('POST /api/comments — auto-watch', () => {
    it('sets newlyWatching=true and creates a WATCH row for a first-time commenter', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}autowatch-new`);

      const res = await request(app)
        .post('/api/comments')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'first comment from other' });

      expect(res.status).toBe(200);
      expect(res.body.newlyWatching).toBe(true);

      const watcher = await Watcher.findOne({ user: otherUserId, target: new Types.ObjectId(pageId) });
      expect(watcher).not.toBeNull();
      expect(watcher.status).toBe(Watcher.STATUS_WATCH);
    });

    it('sets newlyWatching=false on a second comment (already watching)', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}autowatch-second`);
      const headers = authHeaders(otherAccessToken);

      const first = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'one' });
      expect(first.body.newlyWatching).toBe(true);

      const second = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'two' });
      expect(second.status).toBe(200);
      expect(second.body.newlyWatching).toBe(false);

      // Exactly one row — no duplicate WATCH on the repeat comment.
      expect(await Watcher.countDocuments({ user: otherUserId, target: new Types.ObjectId(pageId) })).toBe(1);
    });

    it('respects an existing IGNORE row: newlyWatching=false and status stays IGNORE', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}autowatch-ignore`);
      await Watcher.watchByPageId(otherUserId, new Types.ObjectId(pageId), Watcher.STATUS_IGNORE);

      const res = await request(app)
        .post('/api/comments')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'commenting while ignoring' });

      expect(res.status).toBe(200);
      expect(res.body.newlyWatching).toBe(false);

      const watcher = await Watcher.findOne({ user: otherUserId, target: new Types.ObjectId(pageId) });
      expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
    });
  });

  describe('DELETE /api/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .delete('/api/comments')
        .send({ comment_id: '000000000000000000000000', page_id: '000000000000000000000000' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('deletes a comment when caller has page grant', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}delete-basic`);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'will be removed' });
      const commentId = addRes.body.comment._id as string;

      const delRes = await request(app).delete('/api/comments').set(headers).send({ comment_id: commentId, page_id: pageId });

      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);
      expect(await Comment.countDocuments({ _id: new Types.ObjectId(commentId) })).toBe(0);
    });

    it('returns 403 PAGE_NOT_GRANTED when caller cannot access the page', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}delete-grant`, '# private', 4);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'mine' });
      const commentId = addRes.body.comment._id as string;

      const delRes = await request(app).delete('/api/comments').set(authHeaders(otherAccessToken)).send({ comment_id: commentId, page_id: pageId });

      expect(delRes.status).toBe(403);
      expect(delRes.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await Comment.countDocuments({ _id: new Types.ObjectId(commentId) })).toBe(1);
    });

    it('returns 404 COMMENT_NOT_FOUND when comment does not exist', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}delete-missing`);

      const res = await request(app)
        .delete('/api/comments')
        .set(authHeaders(accessToken))
        .send({ comment_id: new Types.ObjectId().toString(), page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COMMENT_NOT_FOUND');
    });

    it('returns 400 INVALID_REQUEST when ids are malformed', async () => {
      const res = await request(app).delete('/api/comments').set(authHeaders(accessToken)).send({ comment_id: 'bad', page_id: 'also-bad' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 when the comment does not belong to the given page_id (crowi-review CLS-002)', async () => {
      const pageA = await createTestPage(`${PATH_PREFIX}del-a`);
      const pageB = await createTestPage(`${PATH_PREFIX}del-b`);
      // The comment lives on page B.
      const addRes = await request(app)
        .post('/api/comments')
        .set(authHeaders(accessToken))
        .send({ page_id: pageB.pageId, revision_id: pageB.revisionId, comment: 'lives on B' });
      expect(addRes.status).toBe(200);
      const commentId = addRes.body.comment._id as string;

      // Deleting via page_id = A (the caller is granted on A) must not reach a
      // comment that belongs to B — even though grant on A passes.
      const delRes = await request(app).delete('/api/comments').set(authHeaders(accessToken)).send({ comment_id: commentId, page_id: pageA.pageId });
      expect(delRes.status).toBe(404);
      expect(delRes.body.error.code).toBe('COMMENT_NOT_FOUND');
      // The comment still exists.
      expect(await Comment.countDocuments({ _id: new Types.ObjectId(commentId) })).toBe(1);
    });
  });
});
