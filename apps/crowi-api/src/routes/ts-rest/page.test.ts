import request from 'supertest';
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

describe('Routes /api/v2/pages (ts-rest createPage)', () => {
  const PATH_PREFIX = '/ts-rest-create-test/';
  let Page;
  let Revision;
  let accessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    ({ accessToken } = await createTestUser({
      name: 'CreatePage Test',
      username: 'createPageTester',
      email: 'create-page-tester@example.com',
    }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('POST /api/v2/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v2/pages')
        .send({ path: `${PATH_PREFIX}no-auth`, body: '# hello' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('creates a new page when authenticated and returns 200 with the page', async () => {
      const path = `${PATH_PREFIX}basic`;
      const body = '# created via ts-rest';

      const res = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path, body });

      expect(res.status).toBe(200);
      expect(res.body.page).toBeDefined();
      expect(res.body.page.path).toBe(path);
      expect(res.body.page._id).toBeDefined();
      expect(res.body.page.creator.username).toBe('createPageTester');
      expect(res.body.page.revision.body).toBe(body);
      expect(res.body.page.revision.author.username).toBe('createPageTester');

      const pageDoc = await Page.findOne({ path });
      expect(pageDoc).not.toBeNull();
      expect(pageDoc.revision).toBeDefined();
      const revisionDoc = await Revision.findById(pageDoc.revision);
      expect(revisionDoc).not.toBeNull();
      expect(revisionDoc.body).toBe(body);
      expect(revisionDoc.path).toBe(path);
    });

    it('returns 400 PAGE_EXISTS when posting to an existing path twice', async () => {
      const path = `${PATH_PREFIX}duplicate`;
      const headers = authHeaders(accessToken);

      const first = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# first' });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# second' });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('PAGE_EXISTS');
    });
  });
});

describe('Routes /api/v2/pages (ts-rest updatePage)', () => {
  const PATH_PREFIX = '/ts-rest-update-test/';
  let Page;
  let Revision;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'UpdatePage Test', username: 'updatePageTester', email: 'update-page-tester@example.com' }),
      createTestUser({ name: 'UpdatePage Other', username: 'updatePageOther', email: 'update-page-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('PUT /api/v2/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .put('/api/v2/pages')
        .send({ page_id: '000000000000000000000000', body: '# updated' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('updates an existing page when authenticated and returns 200 with new revision', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);

      const createdPageId = createRes.body.page._id;
      const initialRevisionId = createRes.body.page.revision._id;

      const updatedBody = '# updated body';
      const updateRes = await request(app)
        .put('/api/v2/pages')
        .set(headers)
        .send({ page_id: createdPageId, body: updatedBody, revision_id: initialRevisionId });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.page._id).toBe(createdPageId);
      expect(updateRes.body.page.path).toBe(path);
      expect(updateRes.body.page.revision._id).not.toBe(initialRevisionId);
      expect(updateRes.body.page.revision.body).toBe(updatedBody);
      expect(updateRes.body.page.creator.username).toBe('updatePageTester');
      expect(updateRes.body.page.revision.author.username).toBe('updatePageTester');

      const pageDoc = await Page.findById(createdPageId);
      expect(pageDoc.revision.toString()).not.toBe(initialRevisionId);
      const newRevisionDoc = await Revision.findById(pageDoc.revision);
      expect(newRevisionDoc).not.toBeNull();
      expect(newRevisionDoc.body).toBe(updatedBody);
      expect(newRevisionDoc.path).toBe(path);
    });

    it('returns 409 PAGE_REVISION_ERROR when revision_id is stale', async () => {
      const path = `${PATH_PREFIX}conflict`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      const firstUpdate = await request(app).put('/api/v2/pages').set(headers).send({ page_id: pageId, body: '# first update', revision_id: staleRevisionId });
      expect(firstUpdate.status).toBe(200);

      const conflictRes = await request(app).put('/api/v2/pages').set(headers).send({ page_id: pageId, body: '# stale update', revision_id: staleRevisionId });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.error.code).toBe('PAGE_REVISION_ERROR');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).put('/api/v2/pages').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000', body: '# nope' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const path = `${PATH_PREFIX}private`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      // OWNER-grant (4) page so other users cannot access it.
      const createRes = await request(app).post('/api/v2/pages').set(ownerHeaders).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/v2/pages').set(otherHeaders).send({ page_id: pageId, body: '# unauthorized update' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      const pageDoc = await Page.findById(pageId).populate<{ revision: { body: string } }>('revision');
      expect(pageDoc.revision.body).toBe('# private');
    });

    it('returns 400 INVALID_GRANT for out-of-range grant values', async () => {
      const path = `${PATH_PREFIX}bad-grant`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/v2/pages').set(headers).send({ page_id: pageId, body: '# updated', grant: 99 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_GRANT');
    });
  });
});

describe('Routes /api/v2/pages/rename (ts-rest renamePage)', () => {
  const PATH_PREFIX = '/ts-rest-rename-test/';
  let Page;
  let Revision;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'RenamePage Test', username: 'renamePageTester', email: 'rename-page-tester@example.com' }),
      createTestUser({ name: 'RenamePage Other', username: 'renamePageOther', email: 'rename-page-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('POST /api/v2/pages/rename', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v2/pages/rename')
        .send({ page_id: '000000000000000000000000', new_path: `${PATH_PREFIX}target` })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('renames a page when authenticated and returns 200 with the new path', async () => {
      const fromPath = `${PATH_PREFIX}from-basic`;
      const toPath = `${PATH_PREFIX}to-basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: toPath });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.path).toBe(toPath);

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(toPath);
      const revisionDoc = await Revision.findById(pageDoc.revision);
      expect(revisionDoc.path).toBe(toPath);

      // No redirect page should exist when create_redirect is omitted/false.
      const redirectPage = await Page.findOne({ path: fromPath });
      expect(redirectPage).toBeNull();
    });

    it('creates a redirect page at the old path when create_redirect=true', async () => {
      const fromPath = `${PATH_PREFIX}from-redirect`;
      const toPath = `${PATH_PREFIX}to-redirect`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: toPath, create_redirect: true });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(toPath);

      const redirectPage = await Page.findOne({ path: fromPath });
      expect(redirectPage).not.toBeNull();
      expect(redirectPage.redirectTo).toBe(toPath);
    });

    it('does not create a redirect page when the new path is a portal (trailing slash)', async () => {
      const fromPath = `${PATH_PREFIX}from-portal`;
      const toPath = `${PATH_PREFIX}to-portal/`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: toPath, create_redirect: true });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(toPath);

      const redirectPage = await Page.findOne({ path: fromPath });
      expect(redirectPage).toBeNull();
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app)
        .post('/api/v2/pages/rename')
        .set(authHeaders(accessToken))
        .send({ page_id: '000000000000000000000000', new_path: `${PATH_PREFIX}nope` });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const fromPath = `${PATH_PREFIX}private`;
      const toPath = `${PATH_PREFIX}private-renamed`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      // OWNER-grant (4) page so other users cannot access it.
      const createRes = await request(app).post('/api/v2/pages').set(ownerHeaders).send({ path: fromPath, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(otherHeaders).send({ page_id: pageId, new_path: toPath });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page must remain at its original path.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('returns 400 PAGE_INVALID_NAME for forbidden destination paths', async () => {
      const fromPath = `${PATH_PREFIX}from-forbidden`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: '/admin/foo' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_INVALID_NAME');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('returns 400 PAGE_EXISTS when the destination path is already taken by a non-redirect page', async () => {
      const fromPath = `${PATH_PREFIX}from-conflict`;
      const occupiedPath = `${PATH_PREFIX}occupied`;
      const headers = authHeaders(accessToken);

      const createSource = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# source' });
      expect(createSource.status).toBe(200);
      const pageId = createSource.body.page._id;

      const createOccupied = await request(app).post('/api/v2/pages').set(headers).send({ path: occupiedPath, body: '# occupied' });
      expect(createOccupied.status).toBe(200);

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: occupiedPath });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_EXISTS');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('overwrites a redirect page sitting at the destination path', async () => {
      const stalePath = `${PATH_PREFIX}stale-redirect`;
      const intermediatePath = `${PATH_PREFIX}intermediate`;
      const finalPath = `${PATH_PREFIX}final`;
      const headers = authHeaders(accessToken);

      // Create page A at stalePath, then rename to intermediatePath with
      // create_redirect=true: a redirect page is left at stalePath.
      const createA = await request(app).post('/api/v2/pages').set(headers).send({ path: stalePath, body: '# A' });
      expect(createA.status).toBe(200);
      const pageAId = createA.body.page._id;
      const renameA = await request(app)
        .post('/api/v2/pages/rename')
        .set(headers)
        .send({ page_id: pageAId, new_path: intermediatePath, create_redirect: true });
      expect(renameA.status).toBe(200);

      // Create page B at finalPath, then rename to stalePath. The existing
      // redirect page at stalePath should be unlinked and the rename succeed.
      const createB = await request(app).post('/api/v2/pages').set(headers).send({ path: finalPath, body: '# B' });
      expect(createB.status).toBe(200);
      const pageBId = createB.body.page._id;

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageBId, new_path: stalePath });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageBId);
      expect(res.body.page.path).toBe(stalePath);

      // Page B now lives at stalePath and the old redirect record is gone.
      const pagesAtStale = await Page.find({ path: stalePath });
      expect(pagesAtStale).toHaveLength(1);
      expect(pagesAtStale[0]._id.toString()).toBe(pageBId);
      expect(pagesAtStale[0].redirectTo).toBeNull();
    });

    it('returns 409 PAGE_REVISION_ERROR when revision_id is stale', async () => {
      const fromPath = `${PATH_PREFIX}from-revision`;
      const toPath = `${PATH_PREFIX}to-revision`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      // Update the page so the original revision becomes stale.
      const update = await request(app).put('/api/v2/pages').set(headers).send({ page_id: pageId, body: '# bumped', revision_id: staleRevisionId });
      expect(update.status).toBe(200);

      const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: pageId, new_path: toPath, revision_id: staleRevisionId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAGE_REVISION_ERROR');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });
  });
});

describe('Routes /api/v2/pages/like and /api/v2/pages/unlike (ts-rest)', () => {
  const PATH_PREFIX = '/ts-rest-like-test/';
  let Page;
  let accessToken: string;
  let otherAccessToken: string;
  let userId: string;

  beforeAll(async () => {
    Page = crowi.model('Page');

    const owner = await createTestUser({
      name: 'LikePage Test',
      username: 'likePageTester',
      email: 'like-page-tester@example.com',
    });
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();

    const other = await createTestUser({
      name: 'LikePage Other',
      username: 'likePageOther',
      email: 'like-page-other@example.com',
    });
    otherAccessToken = other.accessToken;
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  const createPageViaApi = async (token: string, path: string, body: string, grant?: number) => {
    const payload: { path: string; body: string; grant?: number } = { path, body };
    if (grant !== undefined) payload.grant = grant;
    const res = await request(app).post('/api/v2/pages').set(authHeaders(token)).send(payload);
    if (res.status !== 200) {
      throw new Error(`Failed to seed page (${path}): ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.page as { _id: string; path: string };
  };

  describe('POST /api/v2/pages/like', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/pages/like').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private`, '# private', 4);

      const res = await request(app).post('/api/v2/pages/like').set(authHeaders(otherAccessToken)).send({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page should not have been mutated.
      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker.map((id: { toString(): string }) => id.toString())).not.toContain(userId);
    });

    it('adds the current user to liker on first call and returns the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}like-once`, '# like');

      const res = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.page).toBeDefined();
      expect(res.body.page._id).toBe(page._id);
      expect(res.body.page.liker).toContain(userId);
      expect(res.body.page.likerCount).toBe(1);

      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker.map((id: { toString(): string }) => id.toString())).toContain(userId);
    });

    it('is idempotent: liking twice keeps the user in liker exactly once', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}like-twice`, '# like');

      const first = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(second.status).toBe(200);
      expect(second.body.page.liker).toEqual([userId]);
      expect(second.body.page.likerCount).toBe(1);

      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker).toHaveLength(1);
    });
  });

  describe('POST /api/v2/pages/unlike', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/pages/unlike').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/v2/pages/unlike').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).post('/api/v2/pages/unlike').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private-unlike`, '# private', 4);

      const res = await request(app).post('/api/v2/pages/unlike').set(authHeaders(otherAccessToken)).send({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('removes the current user from liker after a like', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}unlike-after-like`, '# u');

      const likeRes = await request(app).post('/api/v2/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(likeRes.status).toBe(200);
      expect(likeRes.body.page.liker).toContain(userId);

      const res = await request(app).post('/api/v2/pages/unlike').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(page._id);
      expect(res.body.page.liker).not.toContain(userId);
      expect(res.body.page.likerCount).toBe(0);

      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker.map((id: { toString(): string }) => id.toString())).not.toContain(userId);
    });

    it('is idempotent: unliking a non-liked page returns the page unchanged', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}unlike-noop`, '# u');

      const res = await request(app).post('/api/v2/pages/unlike').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(page._id);
      expect(res.body.page.liker).toEqual([]);
      expect(res.body.page.likerCount).toBe(0);
    });
  });
});
