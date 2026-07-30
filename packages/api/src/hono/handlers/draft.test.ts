import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

/**
 * RFC-0004 Phase 3 — drafts endpoints
 * (`POST` / `GET` / `DELETE` under `/api/pages/drafts`).
 *
 * Covers: create on a free path, create-conflict against a published
 * page (400) and against another user's draft (409 + owner), list
 * scoping to the caller, author-only cancel + path release, and the
 * by-path / by-id draft 404 for non-authors.
 */
describe('Routes /api/pages/drafts (Hono draft)', () => {
  const PATH_PREFIX = '/hono-draft-test/';
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;

  beforeAll(async () => {
    const [alice, bob] = await Promise.all([
      createTestUser({ name: 'Draft Alice', username: 'draftAlice', email: 'draft-alice@example.com' }),
      createTestUser({ name: 'Draft Bob', username: 'draftBob', email: 'draft-bob@example.com' }),
    ]);
    aliceToken = alice.accessToken;
    aliceId = alice.user._id.toString();
    bobToken = bob.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
  });

  /** Create a *published* page through the public POST /pages endpoint. */
  const createPublishedPage = async (token: string, suffix: string) => {
    const res = await request(app)
      .post('/api/pages')
      .set(authHeaders(token))
      .send({ path: `${PATH_PREFIX}${suffix}`, body: '# published' });
    expect(res.status).toBe(200);
    return res.body.page._id as string;
  };

  describe('POST /api/pages/drafts', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .post('/api/pages/drafts')
        .set('Content-Type', 'application/json')
        .send({ path: `${PATH_PREFIX}unauth` });

      expect(res.status).toBe(401);
    });

    it('creates a draft at a free path and returns the new pageId', async () => {
      const path = `${PATH_PREFIX}free-path`;
      const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });

      expect(res.status).toBe(201);
      expect(typeof res.body.pageId).toBe('string');

      const Page = crowi.model('Page');
      const page = await Page.findById(res.body.pageId);
      expect(page).not.toBeNull();
      expect(page?.status).toBe('draft');
      expect(page?.creator.toString()).toBe(aliceId);
      expect(page?.path).toBe(path);
    });

    it('creates the draft with the default GRANT_PUBLIC grant (RFC-0005)', async () => {
      // The draft's author-only visibility is enforced by `status:
      // 'draft'`, not by the grant — so the grant defaults to public
      // and the page is visible to others the instant publish-on-save
      // flips the status.
      const path = `${PATH_PREFIX}public-grant`;
      const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });

      expect(res.status).toBe(201);
      const Page = crowi.model('Page');
      const page = await Page.findById(res.body.pageId);
      expect(page?.grant).toBe(Page.GRANT_PUBLIC);
    });

    it('seeds the draft with initialBody when provided', async () => {
      const path = `${PATH_PREFIX}with-body`;
      const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path, initialBody: '# seeded content' });

      expect(res.status).toBe(201);
      const Page = crowi.model('Page');
      const Revision = crowi.model('Revision');
      const page = await Page.findById(res.body.pageId);
      const revision = await Revision.findById(page?.revision);
      expect(revision?.body).toBe('# seeded content');
    });

    it('rejects an uncreatable path with 400 invalid_path', async () => {
      // `/admin/*` is on the forbidden list in Page.isCreatableName.
      const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path: '/admin/secret' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_path');
    });

    it('returns 400 path_taken when a published page already occupies the path', async () => {
      const path = `${PATH_PREFIX}taken-by-published`;
      await createPublishedPage(aliceToken, 'taken-by-published');

      const res = await request(app).post('/api/pages/drafts').set(authHeaders(bobToken)).send({ path });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('path_taken');
    });

    it("returns 409 path_taken_by_draft with owner info when another user's draft holds the path", async () => {
      const path = `${PATH_PREFIX}conflict`;
      const aliceRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      expect(aliceRes.status).toBe(201);

      const bobRes = await request(app).post('/api/pages/drafts').set(authHeaders(bobToken)).send({ path });

      expect(bobRes.status).toBe(409);
      expect(bobRes.body.error).toBe('path_taken_by_draft');
      expect(bobRes.body.owner.id).toBe(aliceId);
      expect(bobRes.body.owner.username).toBe('draftAlice');
      expect(bobRes.body.owner.displayName).toBe('Draft Alice');
      expect(bobRes.body.message).toContain('@draftAlice');
    });

    it('is idempotent for the same author on their own draft path', async () => {
      const path = `${PATH_PREFIX}idempotent`;
      const first = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const second = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.pageId).toBe(first.body.pageId);
    });

    // feature-user-page-subpages-tab — draft orphan hardening. Before this
    // fix, a `Revision.prepareRevision` / `Page.pushRevision` failure AFTER
    // `Page.create` left a revision-less `status: 'draft'` Page behind
    // forever: invisible in the editor (no body to load) but permanently
    // visible to its "creator" in any path-rooted listing that includes
    // drafts (the Subpages tab's `visiblePageStatusOr` draft clause doesn't
    // care whether a revision exists). The `catch` block now compensates by
    // deleting that orphaned Page — best-effort, and the original 400
    // response must be unaffected either way.
    describe('draft orphan hardening (compensating delete on seed-revision failure)', () => {
      it('still returns 400 invalid_path when Revision.prepareRevision throws, and leaves no orphaned Page behind', async () => {
        const path = `${PATH_PREFIX}orphan-prepare-revision`;
        const Revision = crowi.model('Revision');
        const spy = jest.spyOn(Revision, 'prepareRevision').mockRejectedValueOnce(new Error('prepareRevision boom'));

        try {
          const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
          expect(res.status).toBe(400);
          expect(res.body.error).toBe('invalid_path');

          const Page = crowi.model('Page');
          expect(await Page.findOne({ path })).toBeNull();
        } finally {
          spy.mockRestore();
        }
      });

      it('still returns 400 invalid_path when Page.pushRevision throws, and leaves no orphaned Page behind', async () => {
        const path = `${PATH_PREFIX}orphan-push-revision`;
        const Page = crowi.model('Page');
        const spy = jest.spyOn(Page, 'pushRevision').mockRejectedValueOnce(new Error('pushRevision boom'));

        try {
          const res = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
          expect(res.status).toBe(400);
          expect(res.body.error).toBe('invalid_path');

          expect(await Page.findOne({ path })).toBeNull();
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('GET /api/pages/drafts', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/pages/drafts');
      expect(res.status).toBe(401);
    });

    it('returns only the calling user own drafts, newest first', async () => {
      await request(app)
        .post('/api/pages/drafts')
        .set(authHeaders(aliceToken))
        .send({ path: `${PATH_PREFIX}list-a` });
      await request(app)
        .post('/api/pages/drafts')
        .set(authHeaders(aliceToken))
        .send({ path: `${PATH_PREFIX}list-b` });
      await request(app)
        .post('/api/pages/drafts')
        .set(authHeaders(bobToken))
        .send({ path: `${PATH_PREFIX}list-bob` });

      const res = await request(app).get('/api/pages/drafts').set(authHeaders(aliceToken));

      expect(res.status).toBe(200);
      const paths = (res.body.drafts as Array<{ path: string }>).map((d) => d.path);
      expect(paths).toContain(`${PATH_PREFIX}list-a`);
      expect(paths).toContain(`${PATH_PREFIX}list-b`);
      expect(paths).not.toContain(`${PATH_PREFIX}list-bob`);
      for (const d of res.body.drafts as Array<{ pageId: string; createdAt: string }>) {
        expect(typeof d.pageId).toBe('string');
        expect(typeof d.createdAt).toBe('string');
      }
    });
  });

  describe('DELETE /api/pages/drafts/:id', () => {
    it('lets the author cancel their draft and releases the path', async () => {
      const path = `${PATH_PREFIX}cancel-me`;
      const createRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const pageId = createRes.body.pageId as string;

      const delRes = await request(app).delete(`/api/pages/drafts/${pageId}`).set(authHeaders(aliceToken));
      expect(delRes.status).toBe(200);

      const Page = crowi.model('Page');
      expect(await Page.findById(pageId)).toBeNull();

      // Path is free: a fresh draft can be created at it again.
      const recreate = await request(app).post('/api/pages/drafts').set(authHeaders(bobToken)).send({ path });
      expect(recreate.status).toBe(201);
    });

    it("returns 404 draft_not_found when cancelling another user's draft", async () => {
      const path = `${PATH_PREFIX}not-yours`;
      const createRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const pageId = createRes.body.pageId as string;

      const delRes = await request(app).delete(`/api/pages/drafts/${pageId}`).set(authHeaders(bobToken));

      expect(delRes.status).toBe(404);
      expect(delRes.body.error).toBe('draft_not_found');

      // The draft is untouched.
      const Page = crowi.model('Page');
      expect(await Page.findById(pageId)).not.toBeNull();
    });

    it('returns 404 draft_not_found for a non-draft (published) page id', async () => {
      const publishedId = await createPublishedPage(aliceToken, 'cancel-published');

      const delRes = await request(app).delete(`/api/pages/drafts/${publishedId}`).set(authHeaders(aliceToken));

      expect(delRes.status).toBe(404);
      expect(delRes.body.error).toBe('draft_not_found');
    });
  });

  describe('by-path / by-id draft visibility', () => {
    it('returns 404 on GET /pages?path for a non-author', async () => {
      const path = `${PATH_PREFIX}hidden`;
      await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });

      const res = await request(app).get('/api/pages').query({ path }).set(authHeaders(bobToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('lets the draft author read their own draft by path', async () => {
      const path = `${PATH_PREFIX}mine`;
      await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });

      const res = await request(app).get('/api/pages').query({ path }).set(authHeaders(aliceToken));

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(path);
    });

    it('returns 404 on GET /pages?page_id for a non-author', async () => {
      const path = `${PATH_PREFIX}hidden-by-id`;
      const createRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const pageId = createRes.body.pageId as string;

      const res = await request(app).get('/api/pages').query({ page_id: pageId }).set(authHeaders(bobToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('keeps a draft hidden from a non-author even though the grant is public (RFC-0005)', async () => {
      // Regression guard for the RFC-0005 grant change: a draft now
      // carries GRANT_PUBLIC, so the *only* thing hiding it from a
      // non-author is `status: 'draft'`. Confirm a non-author still
      // gets a 404 on a public-grant draft.
      const path = `${PATH_PREFIX}public-grant-hidden`;
      const createRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const pageId = createRes.body.pageId as string;

      const Page = crowi.model('Page');
      expect((await Page.findById(pageId))?.grant).toBe(Page.GRANT_PUBLIC);

      const byPath = await request(app).get('/api/pages').query({ path }).set(authHeaders(bobToken));
      expect(byPath.status).toBe(404);
      expect(byPath.body.error.code).toBe('PAGE_NOT_FOUND');

      const byId = await request(app).get('/api/pages').query({ page_id: pageId }).set(authHeaders(bobToken));
      expect(byId.status).toBe(404);
      expect(byId.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('makes the page visible to other users once publish-on-save flips the status', async () => {
      // The collab save flow flips `status: 'draft' -> 'published'`
      // after a successful save (see save-flow.ts step 6b). Simulate
      // that transition here and confirm a non-author can then read
      // the page — which is only possible because the draft was
      // created with the public grant.
      const path = `${PATH_PREFIX}published-visible`;
      const createRes = await request(app).post('/api/pages/drafts').set(authHeaders(aliceToken)).send({ path });
      const pageId = createRes.body.pageId as string;

      const Page = crowi.model('Page');
      await Page.updateOne({ _id: pageId, status: 'draft' }, { $set: { status: 'published' } });

      const res = await request(app).get('/api/pages').query({ path }).set(authHeaders(bobToken));
      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(path);
    });
  });
});
