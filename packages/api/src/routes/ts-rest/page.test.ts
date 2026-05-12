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

describe('Routes /api/v2/pages (ts-rest deletePage)', () => {
  const PATH_PREFIX = '/ts-rest-delete-test/';
  let Page;
  let Bookmark;
  let Comment;
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Bookmark = crowi.model('Bookmark');
    Comment = crowi.model('Comment');

    const created = await createTestUser({ name: 'DeletePage Test', username: 'deletePageTester', email: 'delete-page-tester@example.com' });
    accessToken = created.accessToken;
    userId = created.user._id.toString();
  });

  // Cleanup both /<prefix>... and /trash/<prefix>... since soft delete moves pages under /trash.
  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    await cleanupPathPrefix(`/trash${PATH_PREFIX}`);
  });

  describe('DELETE /api/v2/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).delete('/api/v2/pages').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('soft-deletes a page when authenticated and returns 200 with /trash/* path and deleted status', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).delete('/api/v2/pages').set(headers).send({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.path).toBe(`/trash${path}`);
      expect(res.body.page.status).toBe('deleted');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc).not.toBeNull();
      expect(pageDoc.path).toBe(`/trash${path}`);
      expect(pageDoc.status).toBe('deleted');

      // A redirect page should exist at the original path pointing to /trash/<path>.
      const redirectPage = await Page.findOne({ path });
      expect(redirectPage).not.toBeNull();
      expect(redirectPage.redirectTo).toBe(`/trash${path}`);
    });

    it('completely deletes a page (hard delete) when completely=true and removes related Bookmarks/Comments', async () => {
      const path = `${PATH_PREFIX}completely`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# delete me' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      // Seed a Bookmark and a Comment for this page so we can verify cascading cleanup.
      await Bookmark.create({ page: pageId, user: userId });
      await Comment.create({ page: pageId, creator: userId, comment: 'bye', commentPosition: -1 });

      expect(await Bookmark.countDocuments({ page: pageId })).toBe(1);
      expect(await Comment.countDocuments({ page: pageId })).toBe(1);

      const res = await request(app).delete('/api/v2/pages').set(headers).send({ page_id: pageId, completely: true });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc).toBeNull();
      expect(await Bookmark.countDocuments({ page: pageId })).toBe(0);
      expect(await Comment.countDocuments({ page: pageId })).toBe(0);
    });

    it('returns 409 PAGE_REVISION_ERROR when revision_id is stale (soft delete)', async () => {
      const path = `${PATH_PREFIX}stale-revision`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      // Bump the revision so the originally-issued revision_id becomes stale.
      const update = await request(app).put('/api/v2/pages').set(headers).send({ page_id: pageId, body: '# updated', revision_id: staleRevisionId });
      expect(update.status).toBe(200);

      const res = await request(app).delete('/api/v2/pages').set(headers).send({ page_id: pageId, revision_id: staleRevisionId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAGE_REVISION_ERROR');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(path);
      expect(pageDoc.status).not.toBe('deleted');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).delete('/api/v2/pages').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 400 PAGE_DELETE_FAILED for non-deletable paths (e.g. /user/<username>)', async () => {
      const headers = authHeaders(accessToken);
      const userPagePath = '/user/deletePageTester';

      // /user/<username> matches isDeletableName's notDeletable patterns, so soft delete
      // should be rejected by the model. Create the user portal page directly because the
      // test harness doesn't auto-create it.
      const Revision = crowi.model('Revision');
      const revision = await Revision.create({ path: userPagePath, body: '# user portal', author: userId, format: 'markdown' });
      const userPage = await Page.create({
        path: userPagePath,
        revision: revision._id,
        creator: userId,
        grant: 1,
      });

      const res = await request(app).delete('/api/v2/pages').set(headers).send({ page_id: userPage._id.toString() });

      // Cleanup the user portal page so it doesn't leak between tests.
      await Page.deleteOne({ _id: userPage._id });
      await Revision.deleteOne({ _id: revision._id });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_DELETE_FAILED');
    });
  });
});

describe('Routes /api/v2/pages/revert (ts-rest revertDeletedPage)', () => {
  const PATH_PREFIX = '/ts-rest-revert-test/';
  let Page;
  let accessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');

    ({ accessToken } = await createTestUser({
      name: 'RevertPage Test',
      username: 'revertPageTester',
      email: 'revert-page-tester@example.com',
    }));
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    await cleanupPathPrefix(`/trash${PATH_PREFIX}`);
  });

  describe('POST /api/v2/pages/revert', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post('/api/v2/pages/revert').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('reverts a soft-deleted page back to its original path and removes the redirect stub', async () => {
      const path = `${PATH_PREFIX}revert-basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const deleteRes = await request(app).delete('/api/v2/pages').set(headers).send({ page_id: pageId });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.page.path).toBe(`/trash${path}`);

      // The redirect stub at the original path is the input the UI would consult,
      // but the revertDeletedPage contract takes the trashed page's id (per planner).
      const res = await request(app).post('/api/v2/pages/revert').set(headers).send({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.path).toBe(path);
      expect(res.body.page.status).toBe('published');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc).not.toBeNull();
      expect(pageDoc.path).toBe(path);
      expect(pageDoc.status).toBe('published');

      // The redirect page that was created at the original path on delete should be
      // completely removed during revert (only the reverted page should remain there).
      const pagesAtPath = await Page.find({ path });
      expect(pagesAtPath).toHaveLength(1);
      expect(pagesAtPath[0]._id.toString()).toBe(pageId);
      expect(pagesAtPath[0].redirectTo).toBeNull();
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).post('/api/v2/pages/revert').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });
});

describe('Routes /api/v2/pages/seen + /pages/seen-users (ts-rest seen)', () => {
  const PATH_PREFIX = '/ts-rest-seen-test/';
  let Page;
  let accessToken: string;
  let otherAccessToken: string;
  let otherUserId: string;

  beforeAll(async () => {
    Page = crowi.model('Page');

    const [owner, other] = await Promise.all([
      createTestUser({ name: 'SeenPage Test', username: 'seenPageTester', email: 'seen-page-tester@example.com' }),
      createTestUser({ name: 'SeenPage Other', username: 'seenPageOther', email: 'seen-page-other@example.com' }),
    ]);
    accessToken = owner.accessToken;
    otherAccessToken = other.accessToken;
    otherUserId = other.user._id.toString();
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('POST /api/v2/pages/seen', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post('/api/v2/pages/seen').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/v2/pages/seen').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND when page_id does not exist', async () => {
      const res = await request(app).post('/api/v2/pages/seen').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('marks the page as seen and returns the populated seenUsers list', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# seen me' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/seen').set(authHeaders(otherAccessToken)).send({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.seenUsersCount).toBe(1);
      expect(res.body.seenUsers).toHaveLength(1);
      expect(res.body.seenUsers[0]._id).toBe(otherUserId);
      expect(res.body.seenUsers[0].username).toBe('seenPageOther');

      // Storage check: page.seenUsers actually contains the user id.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.seenUsers.map((id: { toString: () => string }) => id.toString())).toContain(otherUserId);
    });

    it('is idempotent: re-posting from the same user does not inflate seenUsers', async () => {
      const path = `${PATH_PREFIX}idempotent`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# again' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const otherHeaders = authHeaders(otherAccessToken);
      const first = await request(app).post('/api/v2/pages/seen').set(otherHeaders).send({ page_id: pageId });
      expect(first.status).toBe(200);
      expect(first.body.seenUsersCount).toBe(1);

      const second = await request(app).post('/api/v2/pages/seen').set(otherHeaders).send({ page_id: pageId });
      expect(second.status).toBe(200);
      expect(second.body.seenUsersCount).toBe(1);
      expect(second.body.seenUsers).toHaveLength(1);
      expect(second.body.seenUsers[0]._id).toBe(otherUserId);

      const pageDoc = await Page.findById(pageId);
      // addToSet must not duplicate the same id.
      expect(pageDoc.seenUsers).toHaveLength(1);
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const path = `${PATH_PREFIX}private`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      const createRes = await request(app).post('/api/v2/pages').set(ownerHeaders).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/v2/pages/seen').set(otherHeaders).send({ page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page must remain unmarked-by-other.
      const pageDoc = await Page.findById(pageId);
      const ids = pageDoc.seenUsers.map((id: { toString: () => string }) => id.toString());
      expect(ids).not.toContain(otherUserId);
    });
  });

  describe('GET /api/v2/pages/seen-users', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/v2/pages/seen-users').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/seen-users').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns empty list when no users have seen the page', async () => {
      const path = `${PATH_PREFIX}empty`;
      const createRes = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path, body: '# none' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).get('/api/v2/pages/seen-users').set(authHeaders(accessToken)).query({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.seenUsers).toEqual([]);
      expect(res.body.seenUsersCount).toBe(0);
    });

    it('returns the populated seen-user list without recording a new read receipt', async () => {
      const path = `${PATH_PREFIX}view`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      const createRes = await request(app).post('/api/v2/pages').set(ownerHeaders).send({ path, body: '# look' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const seenRes = await request(app).post('/api/v2/pages/seen').set(otherHeaders).send({ page_id: pageId });
      expect(seenRes.status).toBe(200);

      // GET as the page owner who has NOT marked it as seen — the list should
      // still include `otherUser` but the owner must not be added.
      const res = await request(app).get('/api/v2/pages/seen-users').set(ownerHeaders).query({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.seenUsersCount).toBe(1);
      expect(res.body.seenUsers).toHaveLength(1);
      expect(res.body.seenUsers[0]._id).toBe(otherUserId);

      // Storage assertion: the GET did not add the owner.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.seenUsers).toHaveLength(1);
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const path = `${PATH_PREFIX}forbidden`;
      const createRes = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).get('/api/v2/pages/seen-users').set(authHeaders(otherAccessToken)).query({ page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('caps returned seenUsers via the limit query while seenUsersCount reflects the full count', async () => {
      const path = `${PATH_PREFIX}limit`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      const createRes = await request(app).post('/api/v2/pages').set(ownerHeaders).send({ path, body: '# limit' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      // Two distinct readers leave seen receipts (owner + otherUser).
      await request(app).post('/api/v2/pages/seen').set(ownerHeaders).send({ page_id: pageId });
      await request(app).post('/api/v2/pages/seen').set(otherHeaders).send({ page_id: pageId });

      const res = await request(app).get('/api/v2/pages/seen-users').set(ownerHeaders).query({ page_id: pageId, limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.seenUsersCount).toBe(2);
      expect(res.body.seenUsers).toHaveLength(1);
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

describe('Routes /api/v2/pages/watch (ts-rest)', () => {
  const PATH_PREFIX = '/ts-rest-watch-test/';
  let Page;
  let Watcher;
  let accessToken: string;
  let otherAccessToken: string;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Watcher = crowi.model('Watcher');

    const owner = await createTestUser({
      name: 'WatchPage Test',
      username: 'watchPageTester',
      email: 'watch-page-tester@example.com',
    });
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();

    const other = await createTestUser({
      name: 'WatchPage Other',
      username: 'watchPageOther',
      email: 'watch-page-other@example.com',
    });
    otherAccessToken = other.accessToken;
    otherUserId = other.user._id.toString();
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    // Watchers are independent of page paths, so clean by user too.
    await Watcher.deleteMany({ user: { $in: [userId, otherUserId] } });
  });

  const createPageViaApi = async (token: string, path: string, body: string, grant?: number) => {
    const payload: { path: string; body: string; grant?: number } = { path, body };
    if (grant !== undefined) payload.grant = grant;
    const res = await request(app).post('/api/v2/pages').set(authHeaders(token)).send(payload);
    if (res.status !== 200) {
      throw new Error(`Failed to seed page (${path}): ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.page as { _id: string; path: string };
  };

  describe('GET /api/v2/pages/watch', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/pages/watch').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(accessToken)).query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private`, '# private', 4);
      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns watching=true by default for the page creator (no Watcher record)', async () => {
      // Default watching is derived from getNotificationTargetUsers, which
      // includes the creator. The owner therefore appears as watching=true
      // even without an explicit Watcher row.
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}default-creator`, '# hi');

      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(true);
    });

    it('returns watching=false by default for an unrelated reader (no Watcher record)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}default-other`, '# hi');

      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);
    });

    it('returns watching=true when an explicit WATCH Watcher record exists', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}explicit-watch`, '# w');
      await Watcher.watchByPageId(new Types.ObjectId(otherUserId), new Types.ObjectId(page._id), Watcher.STATUS_WATCH);

      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(true);
    });

    it('returns watching=false when an explicit IGNORE Watcher record exists, even for the creator', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}explicit-ignore`, '# i');
      // Creator is in getNotificationTargetUsers by default but an explicit
      // IGNORE record must override the default.
      await Watcher.watchByPageId(new Types.ObjectId(userId), new Types.ObjectId(page._id), Watcher.STATUS_IGNORE);

      const res = await request(app).get('/api/v2/pages/watch').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);
    });
  });

  describe('PUT /api/v2/pages/watch', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/v2/pages/watch').send({ page_id: '000000000000000000000000', watching: true });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).put('/api/v2/pages/watch').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid', watching: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).put('/api/v2/pages/watch').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000', watching: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private-put`, '# private', 4);
      const res = await request(app).put('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('upserts a WATCH record when watching=true and returns the new state', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}set-watch`, '# w');

      const res = await request(app).put('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(true);

      // target is Schema.Types.Mixed: query with ObjectId because the API
      // handler stores ObjectIds (via loaded.page._id), and Mongoose does
      // not auto-cast on Mixed paths.
      const watcher = await Watcher.findOne({ user: otherUserId, target: new Types.ObjectId(page._id) });
      expect(watcher).not.toBeNull();
      expect(watcher.status).toBe(Watcher.STATUS_WATCH);
      expect(watcher.targetModel).toBe('Page');
    });

    it('upserts an IGNORE record when watching=false and returns the new state', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}set-ignore`, '# i');

      const res = await request(app).put('/api/v2/pages/watch').set(authHeaders(accessToken)).send({ page_id: page._id, watching: false });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);

      const watcher = await Watcher.findOne({ user: userId, target: new Types.ObjectId(page._id) });
      expect(watcher).not.toBeNull();
      expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
    });

    it('flips an existing WATCH record to IGNORE without creating a duplicate', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}flip`, '# flip');

      const first = await request(app).put('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });
      expect(first.status).toBe(200);

      const second = await request(app).put('/api/v2/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: false });
      expect(second.status).toBe(200);
      expect(second.body.watching).toBe(false);

      const watchers = await Watcher.find({ user: otherUserId, target: new Types.ObjectId(page._id) });
      expect(watchers).toHaveLength(1);
      expect(watchers[0].status).toBe(Watcher.STATUS_IGNORE);
    });
  });
});

describe('Routes /api/v2/pages/list (ts-rest listPages — trash / include_deleted)', () => {
  const PATH_PREFIX = '/ts-rest-trash-list-test/';
  let Page;
  let accessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');

    ({ accessToken } = await createTestUser({
      name: 'TrashList Test',
      username: 'trashListTester',
      email: 'trash-list-tester@example.com',
    }));
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    await cleanupPathPrefix(`/trash${PATH_PREFIX}`);
  });

  // Soft-delete a page via the API so it ends up under /trash/<original> with status='deleted'.
  const softDeleteViaApi = async (pageId: string) => {
    const res = await request(app).delete('/api/v2/pages').set(authHeaders(accessToken)).send({ page_id: pageId });
    if (res.status !== 200) {
      throw new Error(`Failed to soft-delete page (${pageId}): ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.page as { _id: string; path: string; status: string };
  };

  it('returns deleted pages when include_deleted=true is set explicitly', async () => {
    const path = `${PATH_PREFIX}explicit`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# to be deleted' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    const deleted = await softDeleteViaApi(pageId);
    expect(deleted.path).toBe(`/trash${path}`);

    // Without the flag — even though we query /trash<prefix>/, server still
    // forces include_deleted=true for /trash/* paths. Use a non-/trash prefix
    // to verify the flag itself works.
    const withoutFlag = await request(app).get('/api/v2/pages/list').set(headers).query({ path: PATH_PREFIX });
    expect(withoutFlag.status).toBe(200);
    const visiblePathsWithoutFlag = (withoutFlag.body.pages as Array<{ path: string }>).map((p) => p.path);
    // The original path was rewritten to /trash/<...> on soft delete; only a redirect
    // page remains at the original path (and it's filtered by redirectTo: null in the query).
    expect(visiblePathsWithoutFlag).not.toContain(path);

    // With include_deleted=true on a /trash<prefix>/ query, the deleted page surfaces.
    const withFlag = await request(app)
      .get('/api/v2/pages/list')
      .set(headers)
      .query({ path: `/trash${PATH_PREFIX}`, include_deleted: 'true' });
    expect(withFlag.status).toBe(200);
    const visiblePathsWithFlag = (withFlag.body.pages as Array<{ path: string; status?: string | null }>).map((p) => p.path);
    expect(visiblePathsWithFlag).toContain(`/trash${path}`);
  });

  it('returns deleted pages for /trash/ paths even when include_deleted is omitted', async () => {
    const path = `${PATH_PREFIX}implicit`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# to be deleted' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    await softDeleteViaApi(pageId);

    const res = await request(app)
      .get('/api/v2/pages/list')
      .set(headers)
      .query({ path: `/trash${PATH_PREFIX}` });
    expect(res.status).toBe(200);

    const pages = res.body.pages as Array<{ _id: string; path: string; status?: string | null }>;
    const found = pages.find((p) => p._id === pageId);
    expect(found).toBeDefined();
    expect(found?.path).toBe(`/trash${path}`);
    expect(found?.status).toBe('deleted');
  });

  it('returns portalPage=null for /trash/ subtrees', async () => {
    const path = `${PATH_PREFIX}portal-suppressed`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# soon-to-be-trash' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    await softDeleteViaApi(pageId);

    const res = await request(app)
      .get('/api/v2/pages/list')
      .set(headers)
      .query({ path: `/trash${PATH_PREFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).toBeNull();
  });
});
