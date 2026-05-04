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
