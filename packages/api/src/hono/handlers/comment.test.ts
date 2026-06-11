import { Types } from 'mongoose';
import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

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

describe('Routes /api/v2/comments (Hono)', () => {
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
    const res = await request(app).post('/api/v2/pages').set(headers).send(payload);
    expect(res.status).toBe(200);
    return {
      pageId: res.body.page._id as string,
      revisionId: res.body.page.revision._id as string,
    };
  };

  describe('GET /api/v2/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/v2/comments').query({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when neither page_id nor revision_id is provided', async () => {
      const res = await request(app).get('/api/v2/comments').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 200 with empty array for a page that has no comments', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}empty`);
      const res = await request(app).get('/api/v2/comments').query({ page_id: pageId }).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.comments).toEqual([]);
    });

    it('returns 200 with comments after they are added', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}with-comments`);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'first comment' });
      expect(addRes.status).toBe(200);

      const listRes = await request(app).get('/api/v2/comments').query({ page_id: pageId }).set(headers);
      expect(listRes.status).toBe(200);
      expect(listRes.body.comments).toHaveLength(1);
      expect(listRes.body.comments[0].comment).toBe('first comment');
      expect(listRes.body.comments[0].creator.username).toBe('honoCommentTester');
      expect(listRes.body.comments[0].revision).toBe(revisionId);
    });
  });

  describe('POST /api/v2/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v2/comments')
        .send({ page_id: '000000000000000000000000', revision_id: '000000000000000000000000', comment: 'x' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('creates a comment and increments Page.commentCount via post-save hook', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}post-basic`);
      const headers = authHeaders(accessToken);

      const res = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'hello world' });

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
        .post('/api/v2/comments')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'sneaky' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
      expect(await Comment.countDocuments({ page: new Types.ObjectId(pageId) })).toBe(0);
    });

    it('returns 400 INVALID_REQUEST when page_id is malformed', async () => {
      const res = await request(app)
        .post('/api/v2/comments')
        .set(authHeaders(accessToken))
        .send({ page_id: 'not-an-objectid', revision_id: '000000000000000000000000', comment: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });
  });

  // feature-watch-autosubscribe — commenting auto-creates a WATCH watcher
  // row for the commenter, surfaced synchronously via `newlyWatching`.
  describe('POST /api/v2/comments — auto-watch', () => {
    it('sets newlyWatching=true and creates a WATCH row for a first-time commenter', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}autowatch-new`);

      const res = await request(app)
        .post('/api/v2/comments')
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

      const first = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'one' });
      expect(first.body.newlyWatching).toBe(true);

      const second = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'two' });
      expect(second.status).toBe(200);
      expect(second.body.newlyWatching).toBe(false);

      // Exactly one row — no duplicate WATCH on the repeat comment.
      expect(await Watcher.countDocuments({ user: otherUserId, target: new Types.ObjectId(pageId) })).toBe(1);
    });

    it('respects an existing IGNORE row: newlyWatching=false and status stays IGNORE', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}autowatch-ignore`);
      await Watcher.watchByPageId(otherUserId, new Types.ObjectId(pageId), Watcher.STATUS_IGNORE);

      const res = await request(app)
        .post('/api/v2/comments')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageId, revision_id: revisionId, comment: 'commenting while ignoring' });

      expect(res.status).toBe(200);
      expect(res.body.newlyWatching).toBe(false);

      const watcher = await Watcher.findOne({ user: otherUserId, target: new Types.ObjectId(pageId) });
      expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
    });
  });

  describe('DELETE /api/v2/comments', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .delete('/api/v2/comments')
        .send({ comment_id: '000000000000000000000000', page_id: '000000000000000000000000' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('deletes a comment when caller has page grant', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}delete-basic`);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'will be removed' });
      const commentId = addRes.body.comment._id as string;

      const delRes = await request(app).delete('/api/v2/comments').set(headers).send({ comment_id: commentId, page_id: pageId });

      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);
      expect(await Comment.countDocuments({ _id: new Types.ObjectId(commentId) })).toBe(0);
    });

    it('returns 403 PAGE_NOT_GRANTED when caller cannot access the page', async () => {
      const { pageId, revisionId } = await createTestPage(`${PATH_PREFIX}delete-grant`, '# private', 4);
      const headers = authHeaders(accessToken);

      const addRes = await request(app).post('/api/v2/comments').set(headers).send({ page_id: pageId, revision_id: revisionId, comment: 'mine' });
      const commentId = addRes.body.comment._id as string;

      const delRes = await request(app).delete('/api/v2/comments').set(authHeaders(otherAccessToken)).send({ comment_id: commentId, page_id: pageId });

      expect(delRes.status).toBe(403);
      expect(delRes.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await Comment.countDocuments({ _id: new Types.ObjectId(commentId) })).toBe(1);
    });

    it('returns 404 COMMENT_NOT_FOUND when comment does not exist', async () => {
      const { pageId } = await createTestPage(`${PATH_PREFIX}delete-missing`);

      const res = await request(app)
        .delete('/api/v2/comments')
        .set(authHeaders(accessToken))
        .send({ comment_id: new Types.ObjectId().toString(), page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COMMENT_NOT_FOUND');
    });

    it('returns 400 INVALID_REQUEST when ids are malformed', async () => {
      const res = await request(app).delete('/api/v2/comments').set(authHeaders(accessToken)).send({ comment_id: 'bad', page_id: 'also-bad' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });
  });
});
