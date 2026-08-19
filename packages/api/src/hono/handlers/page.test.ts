import { Types } from 'mongoose';
import type { SearchDriver, SearchableDoc } from '@crowi/plugin-api';
import { app, crowi, Fixture } from 'src/test/setup';
import { waitForModel } from 'src/test/wait-for-model';
import { authHeaders, createTestUser, createPageViaApi, idempotencyKey } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

const cleanupPathPrefix = (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const filter = { path: { $regex: `^${prefix}` } };
  return Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
};

// --- feature-restricted-grant-share-banner Phase 1 test helpers ---------
// Mirrors the local mock-driver helpers in `search.test.ts` — duplicated
// here rather than shared, matching that file's own "not shared" posture.
interface MockSearchDriver extends SearchDriver {
  indexed: SearchableDoc[];
  removed: string[];
}

const buildMockSearchDriver = (): MockSearchDriver => {
  const driver: MockSearchDriver = {
    indexed: [],
    removed: [],
    async index(doc: SearchableDoc) {
      driver.indexed.push(doc);
    },
    async remove(id: string) {
      driver.removed.push(id);
    },
    async query() {
      return { total: 0, hits: [] };
    },
  };
  return driver;
};

const withMockSearchDriver = async (driver: SearchDriver, fn: () => Promise<void>) => {
  if (!crowi.pluginRegistries) {
    throw new Error('pluginRegistries not initialized — Crowi.init() must run first');
  }
  const original = crowi.pluginRegistries.active.search;
  crowi.pluginRegistries.active.search = driver;
  try {
    await fn();
  } finally {
    crowi.pluginRegistries.active.search = original;
  }
};

describe('Routes /api/pages (Hono createPage)', () => {
  const PATH_PREFIX = '/hono-page-create-test/';
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

  describe('POST /api/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/pages')
        .send({ path: `${PATH_PREFIX}no-auth`, body: '# hello' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('creates a new page when authenticated and returns 200 with the page', async () => {
      const path = `${PATH_PREFIX}basic`;
      const body = '# created via Hono';

      const res = await request(app).post('/api/pages').set(authHeaders(accessToken)).send({ path, body });

      expect(res.status).toBe(200);
      expect(res.body.page).toBeDefined();
      expect(res.body.page.path).toBe(path);
      expect(res.body.page._id).toBeDefined();
      expect(res.body.page.creator.username).toBe('createPageTester');
      expect(res.body.page.revision.body).toBe(body);
      expect(res.body.page.revision.author.username).toBe('createPageTester');
      // Regression guard: `latestRevision` must be the revision id as a plain
      // string (PageResponseSchema.latestRevision: z.string()), not a
      // stringified dump of the whole Revision document. Right after
      // Page.createPage(), `pageData.revision` is a live Document (not yet a
      // bare ObjectId), and Page.populatePageData() used to alias it directly
      // into `latestRevision` instead of capturing just its id.
      expect(res.body.page.latestRevision).toBe(res.body.page.revision._id);
      expect(res.body.page.latestRevision).toMatch(/^[0-9a-f]{24}$/);

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

      const first = await request(app).post('/api/pages').set(headers).send({ path, body: '# first' });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/pages').set(headers).send({ path, body: '# second' });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('PAGE_EXISTS');
    });

    // feature-page-link-space-paths Phase 1: `Page.isCreatableName`
    // forbids a literal '+' (models/page.ts:884) because the web's
    // `+`-as-encoded-space contract (`pagePathToHref` /
    // `decodePagePathFromUrl`, page-path.ts:198-218) means a page whose
    // `path` contains a literal '+' is unreachable by URL for anyone but
    // its creator. Draft creation (draft.test.ts:98-104, `invalid_path`
    // error shape) and rename (below, `PAGE_INVALID_NAME`) already gate on
    // this same check — createPage was the one path missing it.
    it('returns 400 PAGE_INVALID_NAME when the path contains a literal "+"', async () => {
      const path = `${PATH_PREFIX}a+b`;
      const res = await request(app).post('/api/pages').set(authHeaders(accessToken)).send({ path, body: '# plus' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_INVALID_NAME');

      const created = await Page.findOne({ path });
      expect(created).toBeNull();
    });
  });
});

describe('Routes /api/pages (Hono updatePage)', () => {
  const PATH_PREFIX = '/hono-page-update-test/';
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

  describe('PUT /api/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).put('/api/pages').send({ page_id: '000000000000000000000000', body: '# updated' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('updates an existing page when authenticated and returns 200 with new revision', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);

      const createdPageId = createRes.body.page._id;
      const initialRevisionId = createRes.body.page.revision._id;

      const updatedBody = '# updated body';
      const updateRes = await request(app).put('/api/pages').set(headers).send({ page_id: createdPageId, body: updatedBody, revision_id: initialRevisionId });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.page._id).toBe(createdPageId);
      expect(updateRes.body.page.path).toBe(path);
      expect(updateRes.body.page.revision._id).not.toBe(initialRevisionId);
      expect(updateRes.body.page.revision.body).toBe(updatedBody);
      expect(updateRes.body.page.creator.username).toBe('updatePageTester');
      expect(updateRes.body.page.revision.author.username).toBe('updatePageTester');
      // Same aliasing bug reproduces on updatePage: Page.pushRevision() also
      // assigns a live Revision Document to `pageData.revision` right before
      // populatePageData() runs.
      expect(updateRes.body.page.latestRevision).toBe(updateRes.body.page.revision._id);
      expect(updateRes.body.page.latestRevision).toMatch(/^[0-9a-f]{24}$/);

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

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      const firstUpdate = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# first update', revision_id: staleRevisionId });
      expect(firstUpdate.status).toBe(200);

      const conflictRes = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# stale update', revision_id: staleRevisionId });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.error.code).toBe('PAGE_REVISION_ERROR');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).put('/api/pages').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000', body: '# nope' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const path = `${PATH_PREFIX}private`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      // OWNER-grant (4) page so other users cannot access it.
      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/pages').set(otherHeaders).send({ page_id: pageId, body: '# unauthorized update' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      const pageDoc = await Page.findById(pageId).populate<{ revision: { body: string } }>('revision');
      expect(pageDoc.revision.body).toBe('# private');
    });

    it('returns 400 INVALID_GRANT for out-of-range grant values', async () => {
      const path = `${PATH_PREFIX}bad-grant`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# updated', grant: 99 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_GRANT');
    });
  });
});

describe('Routes /api/pages/grant (Hono setPageGrant)', () => {
  const PATH_PREFIX = '/hono-page-grant-test/';
  let Page;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');

    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'Grant Test', username: 'grantTester', email: 'grant-tester@example.com' }),
      createTestUser({ name: 'Grant Other', username: 'grantOther', email: 'grant-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('PUT /api/pages/grant', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).put('/api/pages/grant').send({ page_id: '000000000000000000000000', grant: 4 }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('updates only the grant without pushing a new revision', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const revisionId = createRes.body.page.revision._id;
      expect(createRes.body.page.grant).toBe(1);

      const res = await request(app).put('/api/pages/grant').set(headers).send({ page_id: pageId, grant: 4 });
      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.grant).toBe(4);

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.grant).toBe(4);
      // Grant-only change must NOT create a new revision.
      expect(pageDoc.revision.toString()).toBe(revisionId);
    });

    it('returns 400 INVALID_GRANT for out-of-range grant values', async () => {
      const path = `${PATH_PREFIX}bad-grant`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/pages/grant').set(headers).send({ page_id: pageId, grant: 99 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_GRANT');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).put('/api/pages/grant').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000', grant: 4 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const path = `${PATH_PREFIX}private`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      // OWNER-grant (4) page so other users cannot access it.
      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).put('/api/pages/grant').set(otherHeaders).send({ page_id: pageId, grant: 1 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.grant).toBe(4);
    });

    // RFC-0021 Phase 2c-1 AC-2
    it('setting the SAME grant still returns 200 with the unchanged response shape, and creates no history event', async () => {
      const path = `${PATH_PREFIX}same-grant`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      expect(createRes.body.page.grant).toBe(1);

      const res = await request(app).put('/api/pages/grant').set(headers).send({ page_id: pageId, grant: 1 });
      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.grant).toBe(1);

      const PageHistoryEvent = crowi.model('PageHistoryEvent');
      expect(await PageHistoryEvent.countDocuments({ page: pageId })).toBe(0);
    });

    // RFC-0021 Phase 2c-1 AC-6
    it('a jammed outbox makes the grant change fail with 400, and leaves the DB grant unchanged', async () => {
      const path = `${PATH_PREFIX}jammed-outbox`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      // A malformed `page_event` outbox entry (no `event`) — `materializePendingEntry`
      // always throws on it, so the grant command's drain-assist budget is
      // reliably exhausted.
      await Page.updateOne({ _id: pageId }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });

      const res = await request(app).put('/api/pages/grant').set(headers).send({ page_id: pageId, grant: 4 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_GRANT_UPDATE_FAILED');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.grant).toBe(1);
    });
  });
});

describe('Routes /api/pages/rename (Hono renamePage)', () => {
  const PATH_PREFIX = '/hono-page-rename-test/';
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

  describe('POST /api/pages/rename', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/pages/rename')
        .send({ page_id: '000000000000000000000000', new_path: `${PATH_PREFIX}target` })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('renames a page when authenticated and returns 200 with the new path', async () => {
      const fromPath = `${PATH_PREFIX}from-basic`;
      const toPath = `${PATH_PREFIX}to-basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath });

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

    it('refuses to rename a user home page (/user/<username>) with 400 PAGE_INVALID_NAME', async () => {
      const headers = authHeaders(accessToken);
      const homePath = '/user/renamePageTester';

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: homePath, body: '# home' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: `${PATH_PREFIX}moved-home` });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_INVALID_NAME');

      // The page must stay at its home path.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(homePath);
    });

    it('refuses to rename a page onto a user home path (/user/<name>) with 400 PAGE_INVALID_NAME', async () => {
      const headers = authHeaders(accessToken);
      const fromPath = `${PATH_PREFIX}rename-onto-home`;

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# x' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: '/user/renamePageTester' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_INVALID_NAME');

      // The source page must stay where it is.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('creates a redirect page at the old path when create_redirect=true', async () => {
      const fromPath = `${PATH_PREFIX}from-redirect`;
      const toPath = `${PATH_PREFIX}to-redirect`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath, create_redirect: true });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(toPath);

      const redirectPage = await Page.findOne({ path: fromPath });
      expect(redirectPage).not.toBeNull();
      expect(redirectPage.redirectTo).toBe(toPath);
    });

    it('creates a redirect page when renaming to a portal path with create_redirect (portalize keeps links working)', async () => {
      const fromPath = `${PATH_PREFIX}from-portal`;
      const toPath = `${PATH_PREFIX}to-portal/`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath, create_redirect: true });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(toPath);

      // A portal destination now honours create_redirect (it used to be
      // skipped for `/`-suffixed targets) so links to the old path resolve.
      const redirectPage = await Page.findOne({ path: fromPath });
      expect(redirectPage).not.toBeNull();
      expect(redirectPage.redirectTo).toBe(toPath);
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app)
        .post('/api/pages/rename')
        .set(authHeaders(accessToken))
        .set('Idempotency-Key', idempotencyKey())
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
      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path: fromPath, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(otherHeaders)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page must remain at its original path.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('returns 400 PAGE_INVALID_NAME for forbidden destination paths', async () => {
      const fromPath = `${PATH_PREFIX}from-forbidden`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: '/admin/foo' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_INVALID_NAME');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('returns 400 PAGE_EXISTS when the destination path is already taken by a non-redirect page', async () => {
      const fromPath = `${PATH_PREFIX}from-conflict`;
      const occupiedPath = `${PATH_PREFIX}occupied`;
      const headers = authHeaders(accessToken);

      const createSource = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# source' });
      expect(createSource.status).toBe(200);
      const pageId = createSource.body.page._id;

      const createOccupied = await request(app).post('/api/pages').set(headers).send({ path: occupiedPath, body: '# occupied' });
      expect(createOccupied.status).toBe(200);

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: occupiedPath });

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
      const createA = await request(app).post('/api/pages').set(headers).send({ path: stalePath, body: '# A' });
      expect(createA.status).toBe(200);
      const pageAId = createA.body.page._id;
      const renameA = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageAId, new_path: intermediatePath, create_redirect: true });
      expect(renameA.status).toBe(200);

      // Create page B at finalPath, then rename to stalePath. The existing
      // redirect page at stalePath should be unlinked and the rename succeed.
      const createB = await request(app).post('/api/pages').set(headers).send({ path: finalPath, body: '# B' });
      expect(createB.status).toBe(200);
      const pageBId = createB.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageBId, new_path: stalePath });

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

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      // Update the page so the original revision becomes stale.
      const update = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# bumped', revision_id: staleRevisionId });
      expect(update.status).toBe(200);

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath, revision_id: staleRevisionId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAGE_REVISION_ERROR');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(fromPath);
    });

    it('returns renamed_count: 1 for a single-page rename', async () => {
      const fromPath = `${PATH_PREFIX}count-from`;
      const toPath = `${PATH_PREFIX}count-to`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path: fromPath, body: '# c' });
      const pageId = createRes.body.page._id;

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: toPath });

      expect(res.status).toBe(200);
      expect(res.body.renamed_count).toBe(1);
    });
  });

  describe('POST /api/pages/rename — Idempotency-Key (RFC-0021 Phase 2c-2a)', () => {
    const createPage = async (headers: Record<string, string>, path: string) => {
      const res = await request(app).post('/api/pages').set(headers).send({ path, body: '# body' });
      return res.body.page._id;
    };

    it('AC-8: rejects a single-page rename with no key', async () => {
      const headers = authHeaders(accessToken);
      const pageId = await createPage(headers, `${PATH_PREFIX}idem-missing`);

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .send({ page_id: pageId, new_path: `${PATH_PREFIX}idem-missing-moved` });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      // The page must not have moved.
      const unchanged = await Page.findById(pageId);
      expect(unchanged.path).toBe(`${PATH_PREFIX}idem-missing`);
    });

    it('AC-9: replays the same key + same body without renaming twice', async () => {
      const headers = authHeaders(accessToken);
      const pageId = await createPage(headers, `${PATH_PREFIX}idem-replay`);
      const key = idempotencyKey();
      const body = { page_id: pageId, new_path: `${PATH_PREFIX}idem-replay-moved` };

      const first = await request(app).post('/api/pages/rename').set(headers).set('Idempotency-Key', key).send(body);
      expect(first.status).toBe(200);
      expect(first.headers['idempotency-replayed']).toBeUndefined();

      const second = await request(app).post('/api/pages/rename').set(headers).set('Idempotency-Key', key).send(body);

      expect(second.status).toBe(200);
      expect(second.headers['idempotency-replayed']).toBe('true');
      // One move, one event — the replay answered from the current projection.
      const PageHistoryEvent = crowi.model('PageHistoryEvent');
      expect(await PageHistoryEvent.countDocuments({ page: pageId, kind: 'page_renamed' })).toBe(1);
    });

    it('AC-10: rejects the same key with a different destination', async () => {
      const headers = authHeaders(accessToken);
      const pageId = await createPage(headers, `${PATH_PREFIX}idem-conflict`);
      const key = idempotencyKey();

      const first = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', key)
        .send({ page_id: pageId, new_path: `${PATH_PREFIX}idem-conflict-a` });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', key)
        .send({ page_id: pageId, new_path: `${PATH_PREFIX}idem-conflict-b` });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('AC-11: a destination that is already taken stays a 400 PAGE_EXISTS and records no operation', async () => {
      const headers = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);
      const pageId = await createPage(headers, `${PATH_PREFIX}idem-exists-src`);
      // Owned by someone else, so it cannot be unlinked out of the way.
      const occupied = `${PATH_PREFIX}idem-exists-dest`;
      await createPage(otherHeaders, occupied);

      const PageHistoryOperation = crowi.model('PageHistoryOperation');
      const before = await PageHistoryOperation.countDocuments({});

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: pageId, new_path: occupied });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_EXISTS');
      // Validation runs before the record is written, so a rejected request
      // never burns its key.
      expect(await PageHistoryOperation.countDocuments({})).toBe(before);
    });

    it('AC-14: a subtree rename produces no operation and no event', async () => {
      const headers = authHeaders(accessToken);
      const rootId = await createPage(headers, `${PATH_PREFIX}tree-idem-root`);
      await createPage(headers, `${PATH_PREFIX}tree-idem-root/child`);

      const PageHistoryOperation = crowi.model('PageHistoryOperation');
      const PageHistoryEvent = crowi.model('PageHistoryEvent');
      const before = await PageHistoryOperation.countDocuments({});

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: `${PATH_PREFIX}tree-idem-moved`, include_descendants: true });

      expect(res.status).toBe(200);
      expect(await PageHistoryOperation.countDocuments({})).toBe(before);
      expect(await PageHistoryEvent.countDocuments({ page: rootId, kind: 'page_renamed' })).toBe(0);
      const moved = await Page.findById(rootId);
      expect(moved.status).not.toBe('renaming');
    });
  });

  describe('POST /api/pages/rename (include_descendants — renameTree)', () => {
    it('moves the root and all descendants to the new base path', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}tree-root`;
      const rootTo = `${PATH_PREFIX}tree-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child-a`, body: '# a' });
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child-a/grandchild`, body: '# gc' });
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child-b`, body: '# b' });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(rootTo);
      // root + 3 descendants
      expect(res.body.renamed_count).toBe(4);

      expect(await Page.findOne({ path: rootTo })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/child-a` })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/child-a/grandchild` })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/child-b` })).not.toBeNull();

      // Old descendant paths now only exist as redirect stubs (or nothing).
      const oldChild = await Page.findOne({ path: `${rootFrom}/child-a`, redirectTo: null });
      expect(oldChild).toBeNull();
    });

    it('preserves updatedAt on the root and all descendants (no bump)', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}ts-root`;
      const rootTo = `${PATH_PREFIX}ts-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      const childRes = await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });
      const childId = childRes.body.page._id;

      const rootBefore = await Page.findById(rootId);
      const childBefore = await Page.findById(childId);

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true });
      expect(res.status).toBe(200);

      const rootAfter = await Page.findOne({ path: rootTo });
      const childAfter = await Page.findOne({ path: `${rootTo}/child` });
      expect(rootAfter.updatedAt.getTime()).toBe(rootBefore.updatedAt.getTime());
      expect(childAfter.updatedAt.getTime()).toBe(childBefore.updatedAt.getTime());
    });

    it('creates redirect stubs on each non-portal page when create_redirect=true', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}redir-root`;
      const rootTo = `${PATH_PREFIX}redir-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true, create_redirect: true });
      expect(res.status).toBe(200);

      const rootRedirect = await Page.findOne({ path: rootFrom });
      expect(rootRedirect).not.toBeNull();
      expect(rootRedirect.redirectTo).toBe(rootTo);
      const childRedirect = await Page.findOne({ path: `${rootFrom}/child` });
      expect(childRedirect).not.toBeNull();
      expect(childRedirect.redirectTo).toBe(`${rootTo}/child`);
    });

    it('does not create a redirect for a destination that is a portal path', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}portal-root`;
      const rootTo = `${PATH_PREFIX}portal-moved/`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true, create_redirect: true });
      expect(res.status).toBe(200);

      // The portal root destination ends in '/', so no redirect stub at the
      // old root. The (non-portal) child still gets one.
      const rootRedirect = await Page.findOne({ path: rootFrom });
      expect(rootRedirect).toBeNull();
      const childRedirect = await Page.findOne({ path: `${rootFrom}/child` });
      expect(childRedirect).not.toBeNull();
    });

    it('rejects with a structured 400 PAGE_RENAME_TREE_FAILED when a destination collides', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}clash-root`;
      const rootTo = `${PATH_PREFIX}clash-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });

      // A non-unlinkable page already sits where the child would land, owned
      // by another user with OWNER grant so the renamer cannot unlink it.
      const occupiedChildPath = `${rootTo}/child`;
      await request(app).post('/api/pages').set(authHeaders(otherAccessToken)).send({ path: occupiedChildPath, body: '# occupied', grant: 4 });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_RENAME_TREE_FAILED');
      expect(Array.isArray(res.body.error.conflicts)).toBe(true);
      const conflictPaths = res.body.error.conflicts.map((c: { path: string }) => c.path);
      expect(conflictPaths).toContain(occupiedChildPath);

      // Up-front detection — nothing was moved.
      expect(await Page.findOne({ path: rootFrom })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootFrom}/child` })).not.toBeNull();
      expect(await Page.findOne({ path: rootTo })).toBeNull();
    });

    it('does not move descendants the caller cannot see (grant-filtered, orphaning allowed)', async () => {
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);
      const rootFrom = `${PATH_PREFIX}grant-root`;
      const rootTo = `${PATH_PREFIX}grant-moved`;

      // Public root + a public child, both created by `other` so the renamer
      // can move them; plus an OWNER-grant child owned by `accessToken` that
      // `other` cannot see.
      const rootRes = await request(app).post('/api/pages').set(otherHeaders).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(otherHeaders)
        .send({ path: `${rootFrom}/visible`, body: '# v' });
      await request(app)
        .post('/api/pages')
        .set(ownerHeaders)
        .send({ path: `${rootFrom}/hidden`, body: '# h', grant: 4 });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(otherHeaders)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true });

      expect(res.status).toBe(200);
      // root + visible child only.
      expect(res.body.renamed_count).toBe(2);
      expect(await Page.findOne({ path: rootTo })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/visible` })).not.toBeNull();
      // The hidden child stays where it was (orphaned, allowed).
      expect(await Page.findOne({ path: `${rootFrom}/hidden` })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/hidden` })).toBeNull();
    });

    it('returns 409 when the root revision_id is stale (subtree path)', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}stale-tree-root`;
      const rootTo = `${PATH_PREFIX}stale-tree-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      const staleRevisionId = rootRes.body.page.revision._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });

      // Bump the root revision so the captured id is stale.
      await request(app).put('/api/pages').set(headers).send({ page_id: rootId, body: '# bumped', revision_id: staleRevisionId });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: true, revision_id: staleRevisionId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAGE_REVISION_ERROR');
      expect(await Page.findOne({ path: rootFrom })).not.toBeNull();
      expect(await Page.findOne({ path: rootTo })).toBeNull();
    });

    it('include_descendants:false behaves exactly like a single-page rename (back-compat)', async () => {
      const headers = authHeaders(accessToken);
      const rootFrom = `${PATH_PREFIX}compat-root`;
      const rootTo = `${PATH_PREFIX}compat-moved`;

      const rootRes = await request(app).post('/api/pages').set(headers).send({ path: rootFrom, body: '# root' });
      const rootId = rootRes.body.page._id;
      await request(app)
        .post('/api/pages')
        .set(headers)
        .send({ path: `${rootFrom}/child`, body: '# c' });

      const res = await request(app)
        .post('/api/pages/rename')
        .set(headers)
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: rootId, new_path: rootTo, include_descendants: false });

      expect(res.status).toBe(200);
      expect(res.body.page.path).toBe(rootTo);
      expect(res.body.renamed_count).toBe(1);
      // The child stayed put — only the single root page moved.
      expect(await Page.findOne({ path: `${rootFrom}/child` })).not.toBeNull();
      expect(await Page.findOne({ path: `${rootTo}/child` })).toBeNull();
    });
  });
});

describe('Routes /api/pages/rename-subtree (Hono renameSubtree — portal-less folder)', () => {
  const PATH_PREFIX = '/hono-page-rename-subtree-test/';
  let Page;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'RenameSubtree Test', username: 'renameSubtreeTester', email: 'rename-subtree-tester@example.com' }),
      createTestUser({ name: 'RenameSubtree Other', username: 'renameSubtreeOther', email: 'rename-subtree-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/pages/rename-subtree')
      .send({ old_path: `${PATH_PREFIX}folder/`, new_path: `${PATH_PREFIX}moved/` });
    expect(res.status).toBe(401);
  });

  it('moves every page under a portal-less folder to the new base path', async () => {
    const headers = authHeaders(accessToken);
    const oldFolder = `${PATH_PREFIX}folder/`;
    const newFolder = `${PATH_PREFIX}moved/`;

    // No page exists AT `${PATH_PREFIX}folder` — only descendants under it.
    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${oldFolder}child-a`, body: '# a' });
    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${oldFolder}child-a/grandchild`, body: '# gc' });
    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${oldFolder}child-b`, body: '# b' });

    const res = await request(app).post('/api/pages/rename-subtree').set(headers).send({ old_path: oldFolder, new_path: newFolder });

    expect(res.status).toBe(200);
    expect(res.body.renamed_count).toBe(3);
    expect(await Page.findOne({ path: `${PATH_PREFIX}moved/child-a` })).not.toBeNull();
    expect(await Page.findOne({ path: `${PATH_PREFIX}moved/child-a/grandchild` })).not.toBeNull();
    expect(await Page.findOne({ path: `${PATH_PREFIX}moved/child-b` })).not.toBeNull();
    // Old descendant paths no longer exist as real pages.
    expect(await Page.findOne({ path: `${oldFolder}child-a`, redirectTo: null })).toBeNull();
  });

  it('refuses to rename a subtree that sweeps in a user home page (/user/<name>)', async () => {
    const headers = authHeaders(accessToken);
    // The user's home page + a child under the `/user/` namespace.
    await request(app).post('/api/pages').set(headers).send({ path: '/user/renameSubtreeTester', body: '# home' });
    await request(app).post('/api/pages').set(headers).send({ path: '/user/renameSubtreeTester/note', body: '# note' });

    // Renaming the whole `/user/` subtree would move every user's home
    // page — bypassing the single-page rename guard. It must be refused.
    const res = await request(app)
      .post('/api/pages/rename-subtree')
      .set(headers)
      .send({ old_path: '/user/', new_path: `${PATH_PREFIX}stolen/` });

    expect(res.status).toBe(400);
    // Nothing moved: the home page + child stay put, destination empty.
    expect(await Page.findOne({ path: '/user/renameSubtreeTester' })).not.toBeNull();
    expect(await Page.findOne({ path: '/user/renameSubtreeTester/note' })).not.toBeNull();
    expect(await Page.findOne({ path: `${PATH_PREFIX}stolen/note` })).toBeNull();

    // afterEach only cleans PATH_PREFIX — drop the `/user/` pages we made.
    await Page.deleteMany({ path: { $in: ['/user/renameSubtreeTester', '/user/renameSubtreeTester/note'] } });
  });

  it('does not move descendants the caller cannot see (grant-filtered)', async () => {
    const headers = authHeaders(accessToken);
    const otherHeaders = authHeaders(otherAccessToken);
    const oldFolder = `${PATH_PREFIX}grant-folder/`;
    const newFolder = `${PATH_PREFIX}grant-moved/`;

    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${oldFolder}visible`, body: '# v' });
    // A private page owned by the other user — invisible to the mover.
    await request(app)
      .post('/api/pages')
      .set(otherHeaders)
      .send({ path: `${oldFolder}hidden`, body: '# h', grant: 4 });

    const res = await request(app).post('/api/pages/rename-subtree').set(headers).send({ old_path: oldFolder, new_path: newFolder });

    expect(res.status).toBe(200);
    expect(res.body.renamed_count).toBe(1);
    expect(await Page.findOne({ path: `${PATH_PREFIX}grant-moved/visible` })).not.toBeNull();
    // The invisible page stays put — it was never in the move set.
    expect(await Page.findOne({ path: `${oldFolder}hidden` })).not.toBeNull();
    expect(await Page.findOne({ path: `${PATH_PREFIX}grant-moved/hidden` })).toBeNull();
  });

  it('rejects with a structured 400 when a destination path already exists (nothing moved)', async () => {
    const headers = authHeaders(accessToken);
    const oldFolder = `${PATH_PREFIX}conflict-folder/`;
    const newFolder = `${PATH_PREFIX}conflict-moved/`;

    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${oldFolder}dup`, body: '# d' });
    // A page already sitting at the destination of `dup`.
    await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${newFolder}dup`, body: '# existing' });

    const res = await request(app).post('/api/pages/rename-subtree').set(headers).send({ old_path: oldFolder, new_path: newFolder });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_RENAME_TREE_FAILED');
    expect(res.body.error.conflicts.length).toBeGreaterThan(0);
    // Nothing was moved — the source page is still where it was.
    expect(await Page.findOne({ path: `${oldFolder}dup` })).not.toBeNull();
  });

  it('returns a 400 when there are no movable pages under the path', async () => {
    const headers = authHeaders(accessToken);
    const res = await request(app)
      .post('/api/pages/rename-subtree')
      .set(headers)
      .send({ old_path: `${PATH_PREFIX}empty-folder/`, new_path: `${PATH_PREFIX}empty-moved/` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_RENAME_TREE_FAILED');
  });
});

describe('Routes /api/pages (Hono deletePage)', () => {
  const PATH_PREFIX = '/hono-page-delete-test/';
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

  describe('DELETE /api/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).delete('/api/pages').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('soft-deletes a page when authenticated and returns 200 with /trash/* path and deleted status', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).delete('/api/pages').set(headers).send({ page_id: pageId });

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

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# delete me' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      // Seed a Bookmark and a Comment for this page so we can verify cascading cleanup.
      await Bookmark.create({ page: pageId, user: userId });
      await Comment.create({ page: pageId, creator: userId, comment: 'bye', commentPosition: -1 });

      expect(await Bookmark.countDocuments({ page: pageId })).toBe(1);
      expect(await Comment.countDocuments({ page: pageId })).toBe(1);

      const res = await request(app).delete('/api/pages').set(headers).send({ page_id: pageId, completely: true });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc).toBeNull();
      expect(await Bookmark.countDocuments({ page: pageId })).toBe(0);
      expect(await Comment.countDocuments({ page: pageId })).toBe(0);
    });

    // RFC-0021 §5.1/§5.6 (`feature-page-history-phase2c1-metadata-events`,
    // Phase A, AC-23) — a failed history-event purge still commits the hard
    // delete (Page row is gone) but is reported as 400 `PAGE_DELETE_FAILED`
    // (`hono/handlers/page.ts` serializes `error.message` verbatim into the
    // response body) — the injected driver failure's raw message must never
    // reach that body, only `pageId` + the closed-vocabulary step name.
    it('completely deletes a page even when history-event purge fails, without leaking the driver error into the 400 body (AC-23)', async () => {
      const path = `${PATH_PREFIX}completely-purge-failure`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# delete me too' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const PageHistoryEvent = crowi.model('PageHistoryEvent');
      const spy = jest.spyOn(PageHistoryEvent, 'deleteMany').mockImplementationOnce(
        () =>
          ({
            exec: () => Promise.reject(new Error('MARKER_HANDLER_DRIVER_DETAIL')),
          }) as unknown as ReturnType<typeof PageHistoryEvent.deleteMany>,
      );

      try {
        const res = await request(app).delete('/api/pages').set(headers).send({ page_id: pageId, completely: true });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PAGE_DELETE_FAILED');
        expect(res.body.error.message).not.toContain('MARKER_HANDLER_DRIVER_DETAIL');
        expect(JSON.stringify(res.body)).not.toContain('MARKER_HANDLER_DRIVER_DETAIL');

        // The hard delete itself still committed (Page row is gone) —
        // only the purge failed.
        expect(await Page.findById(pageId)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('returns 409 PAGE_REVISION_ERROR when revision_id is stale (soft delete)', async () => {
      const path = `${PATH_PREFIX}stale-revision`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;
      const staleRevisionId = createRes.body.page.revision._id;

      // Bump the revision so the originally-issued revision_id becomes stale.
      const update = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# updated', revision_id: staleRevisionId });
      expect(update.status).toBe(200);

      const res = await request(app).delete('/api/pages').set(headers).send({ page_id: pageId, revision_id: staleRevisionId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAGE_REVISION_ERROR');

      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.path).toBe(path);
      expect(pageDoc.status).not.toBe('deleted');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).delete('/api/pages').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

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

      const res = await request(app).delete('/api/pages').set(headers).send({ page_id: userPage._id.toString() });

      // Cleanup the user portal page so it doesn't leak between tests.
      await Page.deleteOne({ _id: userPage._id });
      await Revision.deleteOne({ _id: revision._id });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_DELETE_FAILED');
    });
  });
});

describe('Routes /api/pages/revert (Hono revertDeletedPage)', () => {
  const PATH_PREFIX = '/hono-page-revert-test/';
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

  describe('POST /api/pages/revert', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post('/api/pages/revert').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('reverts a soft-deleted page back to its original path and removes the redirect stub', async () => {
      const path = `${PATH_PREFIX}revert-basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# initial' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const deleteRes = await request(app).delete('/api/pages').set(headers).send({ page_id: pageId });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.page.path).toBe(`/trash${path}`);

      // The redirect stub at the original path is the input the UI would consult,
      // but the revertDeletedPage contract takes the trashed page's id (per planner).
      const res = await request(app).post('/api/pages/revert').set(headers).send({ page_id: pageId });

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
      const res = await request(app).post('/api/pages/revert').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });
});

describe('Routes /api/pages/seen + /pages/seen-users (Hono seen)', () => {
  const PATH_PREFIX = '/hono-page-seen-test/';
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

  describe('POST /api/pages/seen', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post('/api/pages/seen').send({ page_id: '000000000000000000000000' }).set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/pages/seen').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND when page_id does not exist', async () => {
      const res = await request(app).post('/api/pages/seen').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('marks the page as seen and returns the populated seenUsers list', async () => {
      const path = `${PATH_PREFIX}basic`;
      const headers = authHeaders(accessToken);

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# seen me' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/pages/seen').set(authHeaders(otherAccessToken)).send({ page_id: pageId });

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

      const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# again' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const otherHeaders = authHeaders(otherAccessToken);
      const first = await request(app).post('/api/pages/seen').set(otherHeaders).send({ page_id: pageId });
      expect(first.status).toBe(200);
      expect(first.body.seenUsersCount).toBe(1);

      const second = await request(app).post('/api/pages/seen').set(otherHeaders).send({ page_id: pageId });
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

      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).post('/api/pages/seen').set(otherHeaders).send({ page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page must remain unmarked-by-other.
      const pageDoc = await Page.findById(pageId);
      const ids = pageDoc.seenUsers.map((id: { toString: () => string }) => id.toString());
      expect(ids).not.toContain(otherUserId);
    });
  });

  describe('GET /api/pages/seen-users', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/pages/seen-users').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).get('/api/pages/seen-users').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns empty list when no users have seen the page', async () => {
      const path = `${PATH_PREFIX}empty`;
      const createRes = await request(app).post('/api/pages').set(authHeaders(accessToken)).send({ path, body: '# none' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).get('/api/pages/seen-users').set(authHeaders(accessToken)).query({ page_id: pageId });

      expect(res.status).toBe(200);
      expect(res.body.seenUsers).toEqual([]);
      expect(res.body.seenUsersCount).toBe(0);
    });

    it('returns the populated seen-user list without recording a new read receipt', async () => {
      const path = `${PATH_PREFIX}view`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# look' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const seenRes = await request(app).post('/api/pages/seen').set(otherHeaders).send({ page_id: pageId });
      expect(seenRes.status).toBe(200);

      // GET as the page owner who has NOT marked it as seen — the list should
      // still include `otherUser` but the owner must not be added.
      const res = await request(app).get('/api/pages/seen-users').set(ownerHeaders).query({ page_id: pageId });

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
      const createRes = await request(app).post('/api/pages').set(authHeaders(accessToken)).send({ path, body: '# private', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      const res = await request(app).get('/api/pages/seen-users').set(authHeaders(otherAccessToken)).query({ page_id: pageId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('caps returned seenUsers via the limit query while seenUsersCount reflects the full count', async () => {
      const path = `${PATH_PREFIX}limit`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# limit' });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id;

      // Two distinct readers leave seen receipts (owner + otherUser).
      await request(app).post('/api/pages/seen').set(ownerHeaders).send({ page_id: pageId });
      await request(app).post('/api/pages/seen').set(otherHeaders).send({ page_id: pageId });

      const res = await request(app).get('/api/pages/seen-users').set(ownerHeaders).query({ page_id: pageId, limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.seenUsersCount).toBe(2);
      expect(res.body.seenUsers).toHaveLength(1);
    });
  });
});

describe('Routes /api/pages/like and /api/pages/unlike (Hono)', () => {
  const PATH_PREFIX = '/hono-page-like-test/';
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

  describe('POST /api/pages/like', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/pages/like').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private`, '# private', 4);

      const res = await request(app).post('/api/pages/like').set(authHeaders(otherAccessToken)).send({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page should not have been mutated.
      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker.map((id: { toString(): string }) => id.toString())).not.toContain(userId);
    });

    it('adds the current user to liker on first call and returns the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}like-once`, '# like');

      const res = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });

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

      const first = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(second.status).toBe(200);
      expect(second.body.page.liker).toEqual([userId]);
      expect(second.body.page.likerCount).toBe(1);

      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker).toHaveLength(1);
    });
  });

  describe('POST /api/pages/unlike', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/pages/unlike').send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).post('/api/pages/unlike').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).post('/api/pages/unlike').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private-unlike`, '# private', 4);

      const res = await request(app).post('/api/pages/unlike').set(authHeaders(otherAccessToken)).send({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('removes the current user from liker after a like', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}unlike-after-like`, '# u');

      const likeRes = await request(app).post('/api/pages/like').set(authHeaders(accessToken)).send({ page_id: page._id });
      expect(likeRes.status).toBe(200);
      expect(likeRes.body.page.liker).toContain(userId);

      const res = await request(app).post('/api/pages/unlike').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(page._id);
      expect(res.body.page.liker).not.toContain(userId);
      expect(res.body.page.likerCount).toBe(0);

      const pageDoc = await Page.findById(page._id);
      expect(pageDoc.liker.map((id: { toString(): string }) => id.toString())).not.toContain(userId);
    });

    it('is idempotent: unliking a non-liked page returns the page unchanged', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}unlike-noop`, '# u');

      const res = await request(app).post('/api/pages/unlike').set(authHeaders(accessToken)).send({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(page._id);
      expect(res.body.page.liker).toEqual([]);
      expect(res.body.page.likerCount).toBe(0);
    });
  });
});

describe('Routes /api/pages/watch (Hono)', () => {
  const PATH_PREFIX = '/hono-page-watch-test/';
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

  // Auto-watch fires from the (fire-and-forget) pageEvent listener, so the
  // Watcher row may not exist yet when the create response returns. Poll on
  // the event loop (shared `waitForModel`) instead of a fixed delay.
  const waitForWatcher = (uid: string, pageId: string) => waitForModel(Watcher, { user: uid, target: new Types.ObjectId(pageId) });

  describe('GET /api/pages/watch', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/pages/watch').query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).get('/api/pages/watch').set(authHeaders(accessToken)).query({ page_id: 'not-an-objectid' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).get('/api/pages/watch').set(authHeaders(accessToken)).query({ page_id: '000000000000000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private`, '# private', 4);
      const res = await request(app).get('/api/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns watching=true for the page creator (auto-watch materialises a WATCH row on create)', async () => {
      // feature-watch-autosubscribe — creating a page auto-creates an
      // explicit WATCH watcher row for the creator (events/page.ts), so
      // getWatchStatus reports watching=true from a real row (no derive-
      // from-getNotificationTargetUsers fallback anymore).
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}default-creator`, '# hi');
      const watcher = await waitForWatcher(userId, page._id);
      expect(watcher).not.toBeNull();
      expect(watcher.status).toBe(Watcher.STATUS_WATCH);

      const res = await request(app).get('/api/pages/watch').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(true);
    });

    it('returns watching=false for an unrelated reader (no Watcher record)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}default-other`, '# hi');

      const res = await request(app).get('/api/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);
    });

    it('returns watching=true when an explicit WATCH Watcher record exists', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}explicit-watch`, '# w');
      await Watcher.watchByPageId(new Types.ObjectId(otherUserId), new Types.ObjectId(page._id), Watcher.STATUS_WATCH);

      const res = await request(app).get('/api/pages/watch').set(authHeaders(otherAccessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(true);
    });

    it('returns watching=false when an explicit IGNORE Watcher record exists, even for the creator', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}explicit-ignore`, '# i');
      // Let the create auto-watch settle first (avoids racing the explicit
      // IGNORE write against the fire-and-forget listener), then flip the
      // creator's row to IGNORE: an explicit opt-out must win.
      await waitForWatcher(userId, page._id);
      await Watcher.watchByPageId(new Types.ObjectId(userId), new Types.ObjectId(page._id), Watcher.STATUS_IGNORE);

      const res = await request(app).get('/api/pages/watch').set(authHeaders(accessToken)).query({ page_id: page._id });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);
    });
  });

  describe('PUT /api/pages/watch', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/pages/watch').send({ page_id: '000000000000000000000000', watching: true });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 INVALID_PAGE_ID when page_id is malformed', async () => {
      const res = await request(app).put('/api/pages/watch').set(authHeaders(accessToken)).send({ page_id: 'not-an-objectid', watching: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 PAGE_NOT_FOUND for unknown page_id', async () => {
      const res = await request(app).put('/api/pages/watch').set(authHeaders(accessToken)).send({ page_id: '000000000000000000000000', watching: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND when caller is not granted access', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}private-put`, '# private', 4);
      const res = await request(app).put('/api/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('upserts a WATCH record when watching=true and returns the new state', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}set-watch`, '# w');

      const res = await request(app).put('/api/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });

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

      const res = await request(app).put('/api/pages/watch').set(authHeaders(accessToken)).send({ page_id: page._id, watching: false });

      expect(res.status).toBe(200);
      expect(res.body.watching).toBe(false);

      const watcher = await Watcher.findOne({ user: userId, target: new Types.ObjectId(page._id) });
      expect(watcher).not.toBeNull();
      expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
    });

    it('flips an existing WATCH record to IGNORE without creating a duplicate', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}flip`, '# flip');

      const first = await request(app).put('/api/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: true });
      expect(first.status).toBe(200);

      const second = await request(app).put('/api/pages/watch').set(authHeaders(otherAccessToken)).send({ page_id: page._id, watching: false });
      expect(second.status).toBe(200);
      expect(second.body.watching).toBe(false);

      const watchers = await Watcher.find({ user: otherUserId, target: new Types.ObjectId(page._id) });
      expect(watchers).toHaveLength(1);
      expect(watchers[0].status).toBe(Watcher.STATUS_IGNORE);
    });
  });
});

describe('Routes /api/pages/list (Hono listPages — trash / include_deleted)', () => {
  const PATH_PREFIX = '/hono-page-trash-list-test/';
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
    const res = await request(app).delete('/api/pages').set(authHeaders(accessToken)).send({ page_id: pageId });
    if (res.status !== 200) {
      throw new Error(`Failed to soft-delete page (${pageId}): ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.page as { _id: string; path: string; status: string };
  };

  it('returns deleted pages when include_deleted=true is set explicitly', async () => {
    const path = `${PATH_PREFIX}explicit`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# to be deleted' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    const deleted = await softDeleteViaApi(pageId);
    expect(deleted.path).toBe(`/trash${path}`);

    // Without the flag — even though we query /trash<prefix>/, server still
    // forces include_deleted=true for /trash/* paths. Use a non-/trash prefix
    // to verify the flag itself works.
    const withoutFlag = await request(app).get('/api/pages/list').set(headers).query({ path: PATH_PREFIX });
    expect(withoutFlag.status).toBe(200);
    const visiblePathsWithoutFlag = (withoutFlag.body.pages as Array<{ path: string }>).map((p) => p.path);
    // The original path was rewritten to /trash/<...> on soft delete; only a redirect
    // page remains at the original path (and it's filtered by redirectTo: null in the query).
    expect(visiblePathsWithoutFlag).not.toContain(path);

    // With include_deleted=true on a /trash<prefix>/ query, the deleted page surfaces.
    const withFlag = await request(app)
      .get('/api/pages/list')
      .set(headers)
      .query({ path: `/trash${PATH_PREFIX}`, include_deleted: 'true' });
    expect(withFlag.status).toBe(200);
    const visiblePathsWithFlag = (withFlag.body.pages as Array<{ path: string; status?: string | null }>).map((p) => p.path);
    expect(visiblePathsWithFlag).toContain(`/trash${path}`);
  });

  it('returns deleted pages for /trash/ paths even when include_deleted is omitted', async () => {
    const path = `${PATH_PREFIX}implicit`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# to be deleted' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    await softDeleteViaApi(pageId);

    const res = await request(app)
      .get('/api/pages/list')
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

    const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# soon-to-be-trash' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id;
    await softDeleteViaApi(pageId);

    const res = await request(app)
      .get('/api/pages/list')
      .set(headers)
      .query({ path: `/trash${PATH_PREFIX}` });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).toBeNull();
  });

  it('includes renderedAst on the portal document so it renders (not stuck on "Rendering…")', async () => {
    // Regression: listPages projected the portal with the lean
    // pageToResponse(portalPage) (no withRenderedAst), so the web
    // PageContent had no AST and showed "Rendering…" forever. The portal
    // is a full page in the UI, so it must carry renderedAst like the
    // getPage detail path.
    const portalPath = `${PATH_PREFIX}portal-render/`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/pages').set(headers).send({ path: portalPath, body: '# Portal heading' });
    expect(createRes.status).toBe(200);

    const res = await request(app).get('/api/pages/list').set(headers).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).not.toBeNull();
    expect(res.body.portalPage.revision.renderedAst).toBeTruthy();
  });
});

/**
 * Listing-handler visibility coverage for the root / no-path branch
 * (`path === '/'` or `path` omitted). The path-based branch routes
 * through `Page.findListByStartWith`, which uses the model's
 * `visiblePageGrantOr` / `visiblePageStatusOr` helpers; the root branch
 * used to hard-code `grant: { $in: [1, 2] }` which silently dropped
 * the viewer's GRANT_OWNER / GRANT_SPECIFIED pages and leaked
 * GRANT_RESTRICTED pages to non-members. These tests pin the fix.
 */
describe('Routes /api/pages/list (Hono listPages — root branch grant visibility)', () => {
  const PATH_PREFIX = '/hono-page-root-grants-test/';
  let aliceHeaders: ReturnType<typeof authHeaders>;
  let bobHeaders: ReturnType<typeof authHeaders>;

  beforeAll(async () => {
    const alice = await createTestUser({ name: 'Root Alice', username: 'rootGrantAlice', email: 'root-grant-alice@example.com' });
    const bob = await createTestUser({ name: 'Root Bob', username: 'rootGrantBob', email: 'root-grant-bob@example.com' });
    aliceHeaders = authHeaders(alice.accessToken);
    bobHeaders = authHeaders(bob.accessToken);
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
  });

  it("surfaces the viewer's GRANT_OWNER pages in the root listing", async () => {
    const path = `${PATH_PREFIX}owner-only`;
    const create = await request(app).post('/api/pages').set(aliceHeaders).send({ path, body: '# private', grant: 4 });
    expect(create.status).toBe(200);
    const pageId = create.body.page._id as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/' });
    expect(list.status).toBe(200);
    const pageIds = (list.body.pages as Array<{ _id: string }>).map((p) => p._id);
    expect(pageIds).toContain(pageId);
  });

  it('keeps GRANT_RESTRICTED pages hidden from non-members in the root listing', async () => {
    const path = `${PATH_PREFIX}restricted-secret`;
    // Restricted to Alice only (no grantedUsers carries the owner here,
    // POST endpoint seeds it for grant=4; for grant=2 we set grantedUsers
    // explicitly via setPageGrant to the owner alone).
    const create = await request(app).post('/api/pages').set(aliceHeaders).send({ path, body: '# secret', grant: 2 });
    expect(create.status).toBe(200);
    const pageId = create.body.page._id as string;

    // Bob is not in the grantedUsers list, so the root listing must
    // omit the page entirely. Previously the hard-coded
    // `grant: { $in: [1, 2] }` would have shown it to Bob.
    const list = await request(app).get('/api/pages/list').set(bobHeaders).query({ path: '/' });
    expect(list.status).toBe(200);
    const pageIds = (list.body.pages as Array<{ _id: string }>).map((p) => p._id);
    expect(pageIds).not.toContain(pageId);
  });

  it("surfaces the viewer's own drafts in a path listing with status='draft'", async () => {
    const path = `${PATH_PREFIX}my-draft`;
    const create = await request(app).post('/api/pages/drafts').set(aliceHeaders).send({ path });
    expect(create.status).toBe(201);
    const pageId = create.body.pageId as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX });
    expect(list.status).toBe(200);
    const draftRow = (list.body.pages as Array<{ _id: string; status?: string }>).find((p) => p._id === pageId);
    expect(draftRow).toBeDefined();
    // The UI relies on `status === 'draft'` to render the draft badge —
    // a regression that elides the status field would silently undo
    // the visual distinction.
    expect(draftRow?.status).toBe('draft');
  });

  it("keeps another user's draft out of the listing", async () => {
    const path = `${PATH_PREFIX}bobs-private-draft`;
    const create = await request(app).post('/api/pages/drafts').set(bobHeaders).send({ path });
    expect(create.status).toBe(201);
    const pageId = create.body.pageId as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX });
    expect(list.status).toBe(200);
    const pageIds = (list.body.pages as Array<{ _id: string }>).map((p) => p._id);
    expect(pageIds).not.toContain(pageId);
  });

  // The two tests above route through findListByStartWith (path branch).
  // The next two pin the root / no-path branch (the else branch this
  // describe block was created to cover) — without them a regression
  // that re-introduces a hard-coded status filter on the else branch
  // would still pass the suite.
  it("surfaces the viewer's own draft in the root listing with status='draft'", async () => {
    const path = `${PATH_PREFIX}root-my-draft`;
    const create = await request(app).post('/api/pages/drafts').set(aliceHeaders).send({ path });
    expect(create.status).toBe(201);
    const pageId = create.body.pageId as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/' });
    expect(list.status).toBe(200);
    const draftRow = (list.body.pages as Array<{ _id: string; status?: string }>).find((p) => p._id === pageId);
    expect(draftRow).toBeDefined();
    expect(draftRow?.status).toBe('draft');
  });

  it("keeps another user's draft out of the root listing", async () => {
    const path = `${PATH_PREFIX}root-bobs-draft`;
    const create = await request(app).post('/api/pages/drafts').set(bobHeaders).send({ path });
    expect(create.status).toBe(201);
    const pageId = create.body.pageId as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/' });
    expect(list.status).toBe(200);
    const pageIds = (list.body.pages as Array<{ _id: string }>).map((p) => p._id);
    expect(pageIds).not.toContain(pageId);
  });

  it("keeps another user's draft out when include_deleted is sent as the string 'false'", async () => {
    // Regression: the web client serialises every query param to a
    // string, so `include_deleted: false` goes on the wire as `"false"`.
    // The schema used `z.coerce.boolean()` (= JS `Boolean("false")` ===
    // true), which flipped include_deleted on and skipped the
    // draft/status filter — leaking other users' drafts into the root
    // listing. Sending the literal string here pins that path.
    const path = `${PATH_PREFIX}root-bobs-draft-falsestr`;
    const create = await request(app).post('/api/pages/drafts').set(bobHeaders).send({ path });
    expect(create.status).toBe(201);
    const pageId = create.body.pageId as string;

    const list = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/', include_deleted: 'false' });
    expect(list.status).toBe(200);
    const pageIds = (list.body.pages as Array<{ _id: string }>).map((p) => p._id);
    expect(pageIds).not.toContain(pageId);
  });

  it('honors include_deleted=true on the root listing (mirrors the path branch)', async () => {
    // Create then soft-delete a page so it lands at /trash/<orig> with
    // status='deleted'. The root branch used to silently ignore the
    // include_deleted flag (visiblePageStatusOr never emits
    // STATUS_DELETED), but now omits the status filter when the flag
    // is set, mirroring findListByStartWith.
    const path = `${PATH_PREFIX}include-deleted-root`;
    const createRes = await request(app).post('/api/pages').set(aliceHeaders).send({ path, body: '# soon-deleted' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id as string;
    const delRes = await request(app).delete('/api/pages').set(aliceHeaders).send({ page_id: pageId });
    expect(delRes.status).toBe(200);

    const withFlag = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/', include_deleted: 'true' });
    expect(withFlag.status).toBe(200);
    const withFlagPaths = (withFlag.body.pages as Array<{ path: string }>).map((p) => p.path);
    expect(withFlagPaths).toContain(`/trash${path}`);

    const withoutFlag = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/' });
    expect(withoutFlag.status).toBe(200);
    const withoutFlagPaths = (withoutFlag.body.pages as Array<{ path: string }>).map((p) => p.path);
    expect(withoutFlagPaths).not.toContain(`/trash${path}`);
  });
});

/**
 * feature-profile-stats-and-page-total — the new top-level `total` on
 * `GET /pages/list`, across every branch (root path='/'/omitted, path
 * prefix, `user=`, include_deleted/trash) and independent of pagination.
 *
 * The root-branch tests use a BEFORE/AFTER delta rather than an absolute
 * expected number: `path=/` and path-omitted match against the whole
 * per-file database (shared with every other describe block in this file),
 * so asserting an absolute total would be coupled to unrelated fixtures'
 * cleanup timing. A delta is exact and independent of that shared state.
 * The path-prefix / user= / trash branches scope their match to this
 * block's own `PATH_PREFIX` (or a specific creator id), so those assert
 * absolute counts directly.
 */
describe('Routes /api/pages/list (Hono listPages — total, feature-profile-stats-and-page-total)', () => {
  const PATH_PREFIX = '/hono-page-list-total-test/';
  let Page: ReturnType<typeof crowi.model>;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let bob: Awaited<ReturnType<typeof createTestUser>>;
  let aliceHeaders: ReturnType<typeof authHeaders>;
  let bobHeaders: ReturnType<typeof authHeaders>;

  beforeAll(async () => {
    Page = crowi.model('Page');
    alice = await createTestUser({ name: 'Total Alice', username: 'totalListAlice', email: 'total-list-alice@example.com' });
    bob = await createTestUser({ name: 'Total Bob', username: 'totalListBob', email: 'total-list-bob@example.com' });
    aliceHeaders = authHeaders(alice.accessToken);
    bobHeaders = authHeaders(bob.accessToken);
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    await cleanupPathPrefix(`/trash${PATH_PREFIX}`);
  });

  it("path=/ — total grows by exactly the newly-visible rows: public + own draft + a page granted (not created) by the viewer; excludes another user's draft and a non-granted page", async () => {
    const before = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/', limit: 1 });
    expect(before.status).toBe(200);
    const totalBefore = before.body.total as number;

    // Visible to alice: public, her own draft, and a restricted page
    // she is granted on (created by bob — exercises the `grantedUsers`
    // branch of visiblePageGrantOr, not just the creator shortcut).
    await request(app)
      .post('/api/pages')
      .set(aliceHeaders)
      .send({ path: `${PATH_PREFIX}root-public`, body: '# public' });
    await request(app)
      .post('/api/pages/drafts')
      .set(aliceHeaders)
      .send({ path: `${PATH_PREFIX}root-my-draft` });
    await Fixture.generate('Page', [
      {
        path: `${PATH_PREFIX}root-granted-to-alice`,
        grant: Page.GRANT_RESTRICTED,
        grantedUsers: [alice.user, bob.user],
        creator: bob.user,
        status: 'published',
      },
    ]);

    // Hidden from alice:
    await request(app)
      .post('/api/pages/drafts')
      .set(bobHeaders)
      .send({ path: `${PATH_PREFIX}root-bobs-draft` });
    await request(app)
      .post('/api/pages')
      .set(bobHeaders)
      .send({ path: `${PATH_PREFIX}root-bobs-restricted`, body: '# secret', grant: 2 });

    const after = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: '/', limit: 1 });
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(totalBefore + 3);
  });

  it('path unspecified — total reflects the same viewer-visible delta as path=/', async () => {
    const before = await request(app).get('/api/pages/list').set(aliceHeaders).query({ limit: 1 });
    expect(before.status).toBe(200);
    const totalBefore = before.body.total as number;

    await request(app)
      .post('/api/pages')
      .set(aliceHeaders)
      .send({ path: `${PATH_PREFIX}nopath-public`, body: '# public' });
    await request(app)
      .post('/api/pages')
      .set(bobHeaders)
      .send({ path: `${PATH_PREFIX}nopath-bobs-restricted`, body: '# secret', grant: 2 });

    const after = await request(app).get('/api/pages/list').set(aliceHeaders).query({ limit: 1 });
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(totalBefore + 1);
  });

  it('path prefix — total equals the visible row count under the prefix and excludes the portal document (dropped from `pages` too)', async () => {
    const portalPath = `${PATH_PREFIX}portal-total/`;
    await createPageViaApi(alice.accessToken, portalPath, '# portal doc');
    await createPageViaApi(alice.accessToken, `${portalPath}child-a`, '# child a');
    await createPageViaApi(alice.accessToken, `${portalPath}child-b`, '# child b');
    // Not granted to alice — must not count.
    await createPageViaApi(bob.accessToken, `${portalPath}bobs-secret`, '# secret', 2);

    const res = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).not.toBeNull();
    expect(res.body.pages.length).toBe(2);
    expect(res.body.total).toBe(2);
  });

  it('path prefix pagination does not undercount a page when the portal document falls inside the first page (regression: portal/content exclusion must be baked into the shared find+count match BEFORE skip/limit, not filtered out of `pages` afterward)', async () => {
    const portalPath = `${PATH_PREFIX}portal-pagination/`;
    await createPageViaApi(alice.accessToken, portalPath, '# portal doc');
    await createPageViaApi(alice.accessToken, `${portalPath}child-a`, '# child a');
    await createPageViaApi(alice.accessToken, `${portalPath}child-b`, '# child b');
    await createPageViaApi(alice.accessToken, `${portalPath}child-c`, '# child c');

    // Sort ascending by path: the portal path is a strict prefix of every
    // child path, so it sorts FIRST — landing inside the `limit: 2` page
    // alongside child-a. If the portal id were dropped from `pages` only
    // AFTER skip/limit (rather than excluded from the match `find`/`count`
    // share), this response would come back with only 1 row and a `null`
    // `pager.next` even though `limit` is 2 and 2 more children remain.
    const page1 = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: portalPath, sort: 'path', order: 'asc', limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.portalPage).not.toBeNull();
    expect(page1.body.total).toBe(3);
    expect((page1.body.pages as Array<{ path: string }>).map((p) => p.path)).toEqual([`${portalPath}child-a`, `${portalPath}child-b`]);
    expect(page1.body.pager).toEqual({ prev: null, next: 2, offset: 0 });

    const page2 = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: portalPath, sort: 'path', order: 'asc', limit: 2, offset: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(3);
    expect((page2.body.pages as Array<{ path: string }>).map((p) => p.path)).toEqual([`${portalPath}child-c`]);
    expect(page2.body.pager).toEqual({ prev: 0, next: null, offset: 2 });
  });

  it('total is stable across offset/limit while pager.next/prev follow the standard next-page pattern', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => createPageViaApi(alice.accessToken, `${PATH_PREFIX}paged-${i}`, `# paged ${i}`)));

    const page1 = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX, limit: 2, offset: 0 });
    const page2 = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX, limit: 2, offset: 2 });
    const page3 = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX, limit: 2, offset: 4 });

    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page2.body.total).toBe(5);
    expect(page3.body.total).toBe(5);
    expect(page1.body.pager).toEqual({ prev: null, next: 2, offset: 0 });
    expect(page2.body.pager).toEqual({ prev: 0, next: 4, offset: 2 });
    expect(page3.body.pager).toEqual({ prev: 2, next: null, offset: 4 });
  });

  it('user=<creator id> — total matches the visible-by-that-creator count, hiding a non-public page from a different viewer', async () => {
    const p1 = await createPageViaApi(bob.accessToken, `${PATH_PREFIX}by-bob-public-a`, '# a');
    const p2 = await createPageViaApi(bob.accessToken, `${PATH_PREFIX}by-bob-public-b`, '# b');
    // Owner-only — hidden from a non-creator viewer even though this is
    // the creator listing's OWN visibility rule (not the root grant rule).
    await createPageViaApi(bob.accessToken, `${PATH_PREFIX}by-bob-owner-only`, '# private', 4);

    const asAlice = await request(app)
      .get('/api/pages/list')
      .set(aliceHeaders)
      .query({ user: String(bob.user._id) });
    expect(asAlice.status).toBe(200);
    expect(asAlice.body.total).toBe(2);
    const idsAsAlice = (asAlice.body.pages as Array<{ _id: string }>).map((p) => p._id).sort();
    expect(idsAsAlice).toEqual([p1._id, p2._id].sort());

    const asBob = await request(app)
      .get('/api/pages/list')
      .set(bobHeaders)
      .query({ user: String(bob.user._id) });
    expect(asBob.status).toBe(200);
    expect(asBob.body.total).toBe(3);
  });

  it('user=<unknown id> — returns total: 0 with an empty pages array (contract-valid, not omitted)', async () => {
    const res = await request(app).get('/api/pages/list').set(aliceHeaders).query({ user: '000000000000000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.pages).toEqual([]);
  });

  it('include_deleted / /trash — total counts a soft-deleted page only via the trash view or include_deleted=true', async () => {
    const created = await createPageViaApi(alice.accessToken, `${PATH_PREFIX}to-delete`, '# bye');
    const del = await request(app).delete('/api/pages').set(aliceHeaders).send({ page_id: created._id });
    expect(del.status).toBe(200);

    // Soft-delete rewrites the path to /trash/<original> — only a
    // redirect stub remains at the original prefix, and `redirectTo: null`
    // excludes it regardless of include_deleted, so the original-prefix
    // total stays 0 either way.
    const withoutFlag = await request(app).get('/api/pages/list').set(aliceHeaders).query({ path: PATH_PREFIX });
    expect(withoutFlag.status).toBe(200);
    expect(withoutFlag.body.total).toBe(0);

    // /trash/* forces include_deleted=true implicitly; passing it
    // explicitly here mirrors the existing trash-branch precedent test.
    const trashView = await request(app)
      .get('/api/pages/list')
      .set(aliceHeaders)
      .query({ path: `/trash${PATH_PREFIX}`, include_deleted: 'true' });
    expect(trashView.status).toBe(200);
    expect(trashView.body.total).toBe(1);
  });

  it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
    const res = await request(app).get('/api/pages/list').query({ path: PATH_PREFIX });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

describe('Routes /api/pages/list (Hono listPages — sort / order)', () => {
  const PATH_PREFIX = '/hono-page-sort-test/';
  let headers: ReturnType<typeof authHeaders>;

  beforeAll(async () => {
    const u = await createTestUser({ name: 'Sort Tester', username: 'sortTester', email: 'sort-tester@example.com' });
    headers = authHeaders(u.accessToken);
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
  });

  // Create a page and return { id, revisionId }. Pages are authored in
  // call order, so createdAt follows the sequence of awaited calls.
  const createPage = async (name: string) => {
    const res = await request(app)
      .post('/api/pages')
      .set(headers)
      .send({ path: `${PATH_PREFIX}${name}`, body: `# ${name}` });
    expect(res.status).toBe(200);
    return { id: res.body.page._id as string, revisionId: res.body.page.revision._id as string };
  };

  // Returned ids restricted to (and in the order of) the three we created.
  const orderedOurs = (body: { pages: Array<{ _id: string }> }, ours: string[]) => body.pages.map((p) => p._id).filter((id) => ours.includes(id));

  it('sorts by name (path) ascending', async () => {
    // Created z → a → m so creation order differs from alphabetical.
    const zebra = await createPage('zebra');
    const alpha = await createPage('alpha');
    const mango = await createPage('mango');

    const list = await request(app).get('/api/pages/list').set(headers).query({ path: PATH_PREFIX, sort: 'path', order: 'asc' });
    expect(list.status).toBe(200);
    expect(orderedOurs(list.body, [zebra.id, alpha.id, mango.id])).toEqual([alpha.id, mango.id, zebra.id]);
  });

  it('sorts by createdAt descending (newest authored first)', async () => {
    const zebra = await createPage('zebra');
    const alpha = await createPage('alpha');
    const mango = await createPage('mango');

    const list = await request(app).get('/api/pages/list').set(headers).query({ path: PATH_PREFIX, sort: 'createdAt', order: 'desc' });
    expect(list.status).toBe(200);
    expect(orderedOurs(list.body, [zebra.id, alpha.id, mango.id])).toEqual([mango.id, alpha.id, zebra.id]);
  });

  it('sorts by updatedAt descending, independent of creation order', async () => {
    const zebra = await createPage('zebra');
    const alpha = await createPage('alpha');
    await createPage('mango');

    // Touch the oldest-created page so its updatedAt becomes the newest;
    // by createdAt it would sort last, by updatedAt it must now lead.
    const upd = await request(app).put('/api/pages').set(headers).send({ page_id: zebra.id, body: '# zebra v2', revision_id: zebra.revisionId });
    expect(upd.status).toBe(200);

    const list = await request(app).get('/api/pages/list').set(headers).query({ path: PATH_PREFIX, sort: 'updatedAt', order: 'desc' });
    expect(list.status).toBe(200);
    const ours = orderedOurs(list.body, [zebra.id, alpha.id]);
    expect(ours[0]).toBe(zebra.id);
  });
});

describe('Routes /api/pages/revert-to-revision (Hono revertToRevision)', () => {
  const PATH_PREFIX = '/hono-page-revert-to-revision-test/';
  let Page;
  let Revision;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'RevertRev Test', username: 'revertRevTester', email: 'revert-rev-tester@example.com' }),
      createTestUser({ name: 'RevertRev Other', username: 'revertRevOther', email: 'revert-rev-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  // Create a page then update it so there are two revisions: v1 (original)
  // and v2 (latest). Returns the ids needed to revert back to v1.
  const seedWithHistory = async (slug: string) => {
    const path = `${PATH_PREFIX}${slug}`;
    const headers = authHeaders(accessToken);

    const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# v1 body' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id as string;
    const v1RevisionId = createRes.body.page.revision._id as string;

    const updateRes = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# v2 body', revision_id: v1RevisionId });
    expect(updateRes.status).toBe(200);
    const v2RevisionId = updateRes.body.page.revision._id as string;

    return { path, pageId, v1RevisionId, v2RevisionId };
  };

  describe('POST /api/pages/revert-to-revision', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/pages/revert-to-revision')
        .send({ page_id: '000000000000000000000000', revision_id: '000000000000000000000000' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('reverts to a past revision by stacking a new revision with the old body', async () => {
      const { path, pageId, v1RevisionId, v2RevisionId } = await seedWithHistory('basic');

      const res = await request(app).post('/api/pages/revert-to-revision').set(authHeaders(accessToken)).send({ page_id: pageId, revision_id: v1RevisionId });

      expect(res.status).toBe(200);
      expect(res.body.page._id).toBe(pageId);
      expect(res.body.page.path).toBe(path);
      // A brand-new revision id (not v1, not v2) carrying the v1 body.
      expect(res.body.page.revision._id).not.toBe(v1RevisionId);
      expect(res.body.page.revision._id).not.toBe(v2RevisionId);
      expect(res.body.page.revision.body).toBe('# v1 body');

      // The page now points at the new revision.
      const pageDoc = await Page.findById(pageId);
      expect(pageDoc.revision.toString()).toBe(res.body.page.revision._id);
    });

    it('is non-destructive: history grows by one and all past revisions remain', async () => {
      const { path, pageId, v1RevisionId } = await seedWithHistory('history');

      const before = await Revision.countDocuments({ path });
      expect(before).toBe(2); // v1 + v2

      const res = await request(app).post('/api/pages/revert-to-revision').set(authHeaders(accessToken)).send({ page_id: pageId, revision_id: v1RevisionId });
      expect(res.status).toBe(200);

      const after = await Revision.countDocuments({ path });
      expect(after).toBe(3); // v1 + v2 + reverted

      // The original revisions are still present (nothing deleted/mutated).
      const stillThere = await Revision.find({ path }).sort({ createdAt: 1 });
      expect(stillThere.map((r) => r.body)).toEqual(['# v1 body', '# v2 body', '# v1 body']);
    });

    it('stacks on the server-side latest even when the page was updated after the old version was opened', async () => {
      const { path, pageId, v1RevisionId } = await seedWithHistory('stale-base');
      const headers = authHeaders(accessToken);

      // Someone updates the page again → v3 is now the latest. The caller is
      // still holding v1 as the version they are viewing.
      const v3Update = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# v3 body' });
      expect(v3Update.status).toBe(200);
      const v3RevisionId = v3Update.body.page.revision._id as string;

      // Revert to v1 — no 409, it simply lands on top of v3.
      const res = await request(app).post('/api/pages/revert-to-revision').set(headers).send({ page_id: pageId, revision_id: v1RevisionId });
      expect(res.status).toBe(200);
      expect(res.body.page.revision.body).toBe('# v1 body');
      expect(res.body.page.revision._id).not.toBe(v3RevisionId);

      // v1, v2, v3 + the reverted one = 4, nothing dropped.
      const count = await Revision.countDocuments({ path });
      expect(count).toBe(4);
    });

    it('returns 404 PAGE_NOT_FOUND for an unknown page_id', async () => {
      const { v1RevisionId } = await seedWithHistory('unknown-page');

      const res = await request(app)
        .post('/api/pages/revert-to-revision')
        .set(authHeaders(accessToken))
        .send({ page_id: '000000000000000000000000', revision_id: v1RevisionId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns 404 PAGE_NOT_FOUND (leak-guard) when the caller is not granted access', async () => {
      const path = `${PATH_PREFIX}private`;
      const ownerHeaders = authHeaders(accessToken);
      const otherHeaders = authHeaders(otherAccessToken);

      // OWNER-grant page seeded with two revisions by its owner.
      const createRes = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# private v1', grant: 4 });
      expect(createRes.status).toBe(200);
      const pageId = createRes.body.page._id as string;
      const v1RevisionId = createRes.body.page.revision._id as string;
      const updateRes = await request(app).put('/api/pages').set(ownerHeaders).send({ page_id: pageId, body: '# private v2', revision_id: v1RevisionId });
      expect(updateRes.status).toBe(200);

      // A non-granted user is collapsed to 404, never reverts.
      const res = await request(app).post('/api/pages/revert-to-revision').set(otherHeaders).send({ page_id: pageId, revision_id: v1RevisionId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');

      // The page's latest is untouched (still v2).
      const pageDoc = await Page.findById(pageId).populate<{ revision: { body: string } }>('revision');
      expect(pageDoc.revision.body).toBe('# private v2');
    });

    it('returns 400 when the revision belongs to a different page', async () => {
      const { pageId } = await seedWithHistory('target');
      // A revision from an unrelated page.
      const other = await seedWithHistory('source');

      const res = await request(app)
        .post('/api/pages/revert-to-revision')
        .set(authHeaders(accessToken))
        .send({ page_id: pageId, revision_id: other.v1RevisionId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_REVERT_TO_REVISION_FAILED');
    });

    it('returns 400 for a malformed revision_id', async () => {
      const { pageId } = await seedWithHistory('bad-rev');

      const res = await request(app)
        .post('/api/pages/revert-to-revision')
        .set(authHeaders(accessToken))
        .send({ page_id: pageId, revision_id: 'not-an-object-id' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_REVERT_TO_REVISION_FAILED');
    });

    it('DC-5 (feature-revision-page-ref): returns 400 — not the leaked body — when revision_id belongs to a page whose path was later reused by a different page', async () => {
      const path = `${PATH_PREFIX}reused-path`;
      const ownerHeaders = authHeaders(accessToken);

      // Page A: owner-only, holds a private body.
      const createA = await request(app).post('/api/pages').set(ownerHeaders).send({ path, body: '# private A secret', grant: 4 });
      expect(createA.status).toBe(200);
      const pageAId = createA.body.page._id as string;
      const revisionAId = createA.body.page.revision._id as string;

      // Hard-delete page A WITHOUT going through Page.removePage — the
      // revision survives, still pointing at the now-gone page A via its
      // immutable `page` id (simulates a standard-lifecycle deviation).
      await Page.deleteOne({ _id: pageAId });

      // Page B: an unrelated PUBLIC page later created at the SAME path.
      const createB = await request(app).post('/api/pages').set(authHeaders(otherAccessToken)).send({ path, body: '# public B' });
      expect(createB.status).toBe(200);
      const pageBId = createB.body.page._id as string;

      // Pre-fix, ownership was checked via `oldRevision.path ===
      // pageData.path` — since both share `path`, this would have passed
      // and let ANY caller with edit access to B "revert" it to A's
      // private body, exposing that body in the response and overwriting
      // B's own content.
      const res = await request(app)
        .post('/api/pages/revert-to-revision')
        .set(authHeaders(otherAccessToken))
        .send({ page_id: pageBId, revision_id: revisionAId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAGE_REVERT_TO_REVISION_FAILED');

      // Page B is untouched.
      const pageBDoc = await Page.findById(pageBId).populate<{ revision: { body: string } }>('revision');
      expect(pageBDoc.revision.body).toBe('# public B');
    });
  });
});

describe('Routes /api/pages (Hono getPage — past revision / stale detection)', () => {
  const PATH_PREFIX = '/hono-page-get-revision-test/';
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser({ name: 'GetRev Test', username: 'getRevTester', email: 'get-rev-tester@example.com' }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  // Create + update so v1 is a PAST revision and v2 is the current latest.
  const seedWithHistory = async (slug: string) => {
    const path = `${PATH_PREFIX}${slug}`;
    const headers = authHeaders(accessToken);
    const createRes = await request(app).post('/api/pages').set(headers).send({ path, body: '# v1 body' });
    expect(createRes.status).toBe(200);
    const pageId = createRes.body.page._id as string;
    const v1RevisionId = createRes.body.page.revision._id as string;
    const updateRes = await request(app).put('/api/pages').set(headers).send({ page_id: pageId, body: '# v2 body', revision_id: v1RevisionId });
    expect(updateRes.status).toBe(200);
    const v2RevisionId = updateRes.body.page.revision._id as string;
    return { path, pageId, v1RevisionId, v2RevisionId };
  };

  describe('GET /api/pages?revision_id=', () => {
    it('serves the past revision body AND surfaces latestRevision so the client can flag it stale', async () => {
      const { path, v1RevisionId, v2RevisionId } = await seedWithHistory('stale');

      const res = await request(app).get('/api/pages').query({ path, revision_id: v1RevisionId }).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      // The requested PAST revision's body is what gets served.
      expect(res.body.page.revision._id).toBe(v1RevisionId);
      expect(res.body.page.revision.body).toBe('# v1 body');
      // latestRevision must point at the CURRENT latest (v2), differing from the
      // viewed revision — this is exactly what drives the "this version" stale
      // banner + revert button on the web. Regression guard: pageToResponse used
      // to read latestRevision off toObject() (which drops the dynamic field set
      // by populatePageData), so it came back undefined and the banner never showed.
      expect(res.body.page.latestRevision).toBe(v2RevisionId);
      expect(res.body.page.latestRevision).not.toBe(res.body.page.revision._id);
    });

    it('reports latestRevision === the viewed revision when opened at the latest (not stale)', async () => {
      const { path, v2RevisionId } = await seedWithHistory('latest');

      const res = await request(app).get('/api/pages').query({ path, revision_id: v2RevisionId }).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.page.revision._id).toBe(v2RevisionId);
      // Viewing the latest: latestRevision equals the viewed revision, so the
      // web treats it as NOT stale and shows no banner.
      expect(res.body.page.latestRevision).toBe(v2RevisionId);
    });

    it('DC-5 (feature-revision-page-ref): returns 404 — not the leaked body — when revision_id belongs to a page whose path was later reused by a different page', async () => {
      const Page = crowi.model('Page');
      const path = `${PATH_PREFIX}reused-path`;
      const headers = authHeaders(accessToken);

      // Page A: owner-only, holds a private body.
      const createA = await request(app).post('/api/pages').set(headers).send({ path, body: '# private A secret', grant: 4 });
      expect(createA.status).toBe(200);
      const pageAId = createA.body.page._id as string;
      const revisionAId = createA.body.page.revision._id as string;

      // Hard-delete page A WITHOUT going through Page.removePage — the
      // revision survives, still pointing at the now-gone page A via its
      // immutable `page` id (simulates a standard-lifecycle deviation).
      await Page.deleteOne({ _id: pageAId });

      // Page B: an unrelated PUBLIC page later created at the SAME path.
      const createB = await request(app).post('/api/pages').set(headers).send({ path, body: '# public B' });
      expect(createB.status).toBe(200);

      // Pre-fix, `Page.findPage` handed `revisionId` straight to
      // `populatePageData`, which blindly assigns + populates it with no
      // ownership check — this would have served A's private body through
      // B's public grant (`path` matches both, but `revision.page` does
      // not match page B's `_id`).
      const res = await request(app).get('/api/pages').query({ path, revision_id: revisionAId }).set(headers);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });

  // feature-restricted-grant-share-banner Phase 1 — grant-on-first-access
  // is confined to `POST /pages/link-access`; `GET /pages?page_id=` (this
  // `page_id` branch) must stay byte-for-byte unchanged, for every caller
  // kind, so `/_edit?page_id=` / `/_attachments?page_id=` (which use this
  // same branch via `usePage({ page_id })`) can never become an implicit
  // invite surface.
  describe('page_id branch — grant-on-first-access regression (feature-restricted-grant-share-banner)', () => {
    const REGRESSION_PREFIX = '/hono-page-get-linkaccess-regression-test/';
    let ownerToken: string;

    beforeAll(async () => {
      ({ accessToken: ownerToken } = await createTestUser({
        name: 'GetPageId Regression Owner',
        username: 'getPageIdRegressionOwner',
        email: 'get-page-id-regression-owner@example.com',
      }));
    });

    afterEach(() => cleanupPathPrefix(REGRESSION_PREFIX));

    it('still 403s a non-granted web caller for a GRANT_RESTRICTED page_id, without writing grantedUsers', async () => {
      const page = await createPageViaApi(ownerToken, `${REGRESSION_PREFIX}web`, '# restricted', 2 /* GRANT_RESTRICTED */);
      const { accessToken: strangerToken, user: stranger } = await createTestUser({
        name: 'GetPageId Regression Stranger Web',
        username: 'getPageIdRegressionStrangerWeb',
        email: 'get-page-id-regression-stranger-web@example.com',
      });

      const res = await request(app).get('/api/pages').query({ page_id: page._id }).set(authHeaders(strangerToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAGE_NOT_GRANTED');

      const Page = crowi.model('Page');
      const reloaded = await Page.findById(page._id).select('grantedUsers').lean();
      expect((reloaded?.grantedUsers ?? []).map(String)).not.toContain(stranger._id.toString());
    });

    it('still 403s a non-granted OAuth/PAT caller for a GRANT_RESTRICTED page_id (no grant-on-access here either)', async () => {
      const page = await createPageViaApi(ownerToken, `${REGRESSION_PREFIX}oauth-pat`, '# restricted', 2);
      const { user: stranger } = await createTestUser({
        name: 'GetPageId Regression Stranger OAuth',
        username: 'getPageIdRegressionStrangerOauth',
        email: 'get-page-id-regression-stranger-oauth@example.com',
      });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: stranger, scopes: ['pages:read'], clientId: 'crowi-cli' });

      const res = await request(app).get('/api/pages').query({ page_id: page._id }).set(authHeaders(oauthToken));
      expect(res.status).toBe(403);

      const Page = crowi.model('Page');
      const reloaded = await Page.findById(page._id).select('grantedUsers').lean();
      expect((reloaded?.grantedUsers ?? []).map(String)).not.toContain(stranger._id.toString());
    });

    it('/_edit / /_attachments auth-boundary escape regression: reading a restricted page_id never grants access, and write ops through the same lookup stay 403/404', async () => {
      const page = await createPageViaApi(ownerToken, `${REGRESSION_PREFIX}edit-escape`, '# restricted', 2);
      const { accessToken: strangerToken, user: stranger } = await createTestUser({
        name: 'GetPageId Regression Edit Escape',
        username: 'getPageIdRegressionEditEscape',
        email: 'get-page-id-regression-edit-escape@example.com',
      });

      // `/_edit?page_id=` and `/_attachments?page_id=` both resolve through
      // `usePage({ page_id })` -> `GET /pages?page_id=`. Simulate opening
      // either screen: still 403, still no grantedUsers write.
      const readRes = await request(app).get('/api/pages').query({ page_id: page._id }).set(authHeaders(strangerToken));
      expect(readRes.status).toBe(403);

      const Page = crowi.model('Page');
      const afterRead = await Page.findById(page._id).select('grantedUsers').lean();
      expect((afterRead?.grantedUsers ?? []).map(String)).not.toContain(stranger._id.toString());

      // Editor/save-adjacent operations (findPageByIdAndGrantedUser-backed)
      // must still be denied for the same non-granted user — reading the
      // page_id branch must not have silently upgraded their access.
      const updateRes = await request(app).put('/api/pages').set(authHeaders(strangerToken)).send({ page_id: page._id, body: '# hijacked' });
      expect([403, 404]).toContain(updateRes.status);

      const afterWrite = await Page.findById(page._id).select('grantedUsers').lean();
      expect((afterWrite?.grantedUsers ?? []).map(String)).not.toContain(stranger._id.toString());
    });
  });
});

// feature-live-page-sync-reconcile — the getPage catch used to collapse
// EVERY unknown exception into 404 (`PAGE_NOT_FOUND`), which made a page
// that failed to RENDER indistinguishable from a page that doesn't exist.
// A reconcile head-GET (the read-side soft-refresh's tab-revisit /
// reconnect-barrier / periodic-backstop fetch) treats 404 as "page was
// deleted" and switches the viewer to `NotFoundCard` — so a transient
// render-artifact failure used to make a perfectly live page vanish for
// every viewer reconciling their cache. This split routes anything other
// than the genuine not-found/not-granted branches to 500 instead.
describe('Routes /api/pages (Hono getPage — unknown-error 500 split, feature-live-page-sync-reconcile)', () => {
  const PATH_PREFIX = '/hono-page-get-500-split-test/';
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser({ name: 'Get500 Test', username: 'get500Tester', email: 'get-500-tester@example.com' }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('returns 500 INTERNAL_ERROR (not 404) when the render-artifact fallback pipeline throws', async () => {
    const path = `${PATH_PREFIX}render-failure`;
    await createPageViaApi(accessToken, path, '# body');

    const pageResponseModule = await import('src/util/page-response');
    const spy = jest.spyOn(pageResponseModule, 'computeRevisionRenderArtifactsAsync').mockRejectedValueOnce(new Error('renderer boom'));

    try {
      const res = await request(app).get('/api/pages').query({ path }).set(authHeaders(accessToken));

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 404 PAGE_NOT_FOUND for a genuinely missing page (unaffected by the 500 split)', async () => {
    const res = await request(app)
      .get('/api/pages')
      .query({ path: `${PATH_PREFIX}does-not-exist` })
      .set(authHeaders(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });
});

// feature-plugin-renderer-mermaid spec §6 — `computeRevisionRenderArtifactsAsync`
// now requires an `actor: RenderActor` argument (admission control's
// per-user concurrency cap needs an end-to-end actor identity, AC
// "Phase 1" item on `RenderContext.actor`/`Renderer.run` options). Type-
// check alone proves the call SHAPE is correct; this proves the VALUE
// actually reaching it is the authenticated caller, not e.g. a stray
// `{ kind: 'system' }` — a spy on the real (imported) function, exercised
// through the full HTTP path.
describe('Routes /api/pages (Hono getPage — actor wiring, feature-plugin-renderer-mermaid spec §6)', () => {
  const PATH_PREFIX = '/hono-page-get-actor-wiring-test/';
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    const { accessToken: token, user } = await createTestUser({
      name: 'ActorWiring Tester',
      username: 'actorWiringTester',
      email: 'actor-wiring-tester@example.com',
    });
    accessToken = token;
    userId = user._id.toString();
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('passes actor: { kind: "user", userId } — the authenticated caller, not a placeholder — to computeRevisionRenderArtifactsAsync', async () => {
    const path = `${PATH_PREFIX}actor`;
    await createPageViaApi(accessToken, path, '# body');

    const pageResponseModule = await import('src/util/page-response');
    const spy = jest.spyOn(pageResponseModule, 'computeRevisionRenderArtifactsAsync');
    try {
      const res = await request(app).get('/api/pages').query({ path }).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      // computeRevisionRenderArtifactsAsync(crowi, storedMeta, storedAst, body, actor, storedRendererVersion?, pageId?)
      const actorArg = spy.mock.calls[0]?.[4];
      expect(actorArg).toEqual({ kind: 'user', userId });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Routes /api/pages/link-access (Hono claimPageLinkAccessRoute — grant-on-first-access, feature-restricted-grant-share-banner Phase 1)', () => {
  const PATH_PREFIX = '/hono-page-link-access-test/';
  const GRANT_PUBLIC = 1;
  const GRANT_RESTRICTED = 2;
  const GRANT_SPECIFIED = 3;
  const GRANT_OWNER = 4;

  let owner: Awaited<ReturnType<typeof createTestUser>>['user'];
  let ownerToken: string;
  let ownerId: string;
  let claimant: Awaited<ReturnType<typeof createTestUser>>['user'];
  let claimantToken: string;
  let claimantId: string;

  beforeAll(async () => {
    const ownerSeed = await createTestUser({ name: 'Link Access Owner', username: 'linkAccessOwner', email: 'link-access-owner@example.com' });
    owner = ownerSeed.user;
    ownerToken = ownerSeed.accessToken;
    ownerId = owner._id.toString();

    const claimantSeed = await createTestUser({ name: 'Link Access Claimant', username: 'linkAccessClaimant', email: 'link-access-claimant@example.com' });
    claimant = claimantSeed.user;
    claimantToken = claimantSeed.accessToken;
    claimantId = claimant._id.toString();
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  const claim = (token: string, pageId: string) => request(app).post('/api/pages/link-access').set(authHeaders(token)).send({ page_id: pageId });

  const grantedUsersOf = async (pageId: string): Promise<string[]> => {
    const Page = crowi.model('Page');
    const reloaded = await Page.findById(pageId).select('grantedUsers').lean();
    return (reloaded?.grantedUsers ?? []).map(String);
  };

  describe('grant-on-first-access', () => {
    it('grants a non-creator, non-granted user access to a GRANT_RESTRICTED page (granted: true) and the redirect-after-claim path read then succeeds', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}first-claim`, '# restricted', GRANT_RESTRICTED);

      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(true);
      expect(res.body.page._id).toBe(page._id);
      expect(await grantedUsersOf(page._id)).toContain(claimantId);

      // Regression: IdRedirector -> PageView's post-redirect path read
      // actually succeeds now that the claim committed.
      const pathRes = await request(app).get('/api/pages').query({ path: page.path }).set(authHeaders(claimantToken));
      expect(pathRes.status).toBe(200);
    });

    it('403s a different user who never claimed the page, both via the claim endpoint and the canonical path', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}never-claimed`, '# restricted', GRANT_RESTRICTED);
      const stranger = await createTestUser({
        name: 'Link Access Never Claimed',
        username: 'linkAccessNeverClaimed',
        email: 'link-access-never-claimed@example.com',
      });

      const pathRes = await request(app).get('/api/pages').query({ path: page.path }).set(authHeaders(stranger.accessToken));
      expect(pathRes.status).toBe(403);
      expect(pathRes.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await grantedUsersOf(page._id)).not.toContain(stranger.user._id.toString());
    });

    it.each([
      ['GRANT_SPECIFIED', GRANT_SPECIFIED],
      ['GRANT_OWNER', GRANT_OWNER],
    ])('does not invite into a %s page (grant-on-access is confined to GRANT_RESTRICTED)', async (_label, grant) => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}non-restricted-${grant}`, '# body', grant);

      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await grantedUsersOf(page._id)).not.toContain(claimantId);
    });
  });

  describe('pass-through (zero grant side effects)', () => {
    it('a GRANT_PUBLIC page resolves with granted: false for any authenticated user', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}public-passthrough`, '# body', GRANT_PUBLIC);
      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(false);
    });

    it('the creator opening their own GRANT_RESTRICTED page is a pass-through', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}creator-passthrough`, '# body', GRANT_RESTRICTED);
      const res = await claim(ownerToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(false);
    });

    it('a second claim by an already-granted user is a pass-through, with no duplicate grantedUsers entry', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}already-granted`, '# body', GRANT_RESTRICTED);

      const first = await claim(claimantToken, page._id);
      expect(first.body.granted).toBe(true);

      const second = await claim(claimantToken, page._id);
      expect(second.status).toBe(200);
      expect(second.body.granted).toBe(false);

      const ids = await grantedUsersOf(page._id);
      expect(ids.filter((id) => id === claimantId)).toHaveLength(1);
    });

    it('a GRANT_OWNER page opened by its own creator (id link to their own private page) is a pass-through', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}owner-self`, '# body', GRANT_OWNER);
      const res = await claim(ownerToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(false);
    });

    it('a GRANT_SPECIFIED page opened by an existing grantedUsers member (non-creator) is a pass-through', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}specified-member`, '# body', GRANT_SPECIFIED);
      // `PUT /pages/grant` (setPageGrant -> Page.updateGrant) only ever adds
      // the *caller* (the one changing the grant) to `grantedUsers` — there
      // is no HTTP path to add a non-creator member to a GRANT_SPECIFIED
      // page's allow-list (that legacy UI is out of scope, see the spec's
      // "outOfScope"). Seed `claimant`'s membership directly via the model
      // to exercise the genuine "non-creator existing member" pass-through.
      const Page = crowi.model('Page');
      await Page.findByIdAndUpdate(page._id, { $addToSet: { grantedUsers: claimantId } });

      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(false);
      expect(await grantedUsersOf(page._id)).toContain(claimantId);
    });

    it('same-user concurrent claims do not create duplicate grantedUsers entries (Promise.all)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}concurrent-claims`, '# body', GRANT_RESTRICTED);

      const responses = await Promise.all(Array.from({ length: 5 }, () => claim(claimantToken, page._id)));
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const ids = await grantedUsersOf(page._id);
      expect(ids.filter((id) => id === claimantId)).toHaveLength(1);
    });
  });

  describe('deleted / redirect-stub / rename interactions', () => {
    it('does not grant access to a deleted GRANT_RESTRICTED page', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}deleted`, '# body', GRANT_RESTRICTED);
      const delRes = await request(app).delete('/api/pages').set(authHeaders(ownerToken)).send({ page_id: page._id });
      expect(delRes.status).toBe(200);

      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(403);
      expect(await grantedUsersOf(page._id)).not.toContain(claimantId);
    });

    it('a redirect stub left behind by a rename resolves as a public pass-through, not an invite target', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}rename-source`, '# body', GRANT_RESTRICTED);
      const renameRes = await request(app)
        .post('/api/pages/rename')
        .set(authHeaders(ownerToken))
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: page._id, new_path: `${PATH_PREFIX}rename-dest`, create_redirect: true });
      expect(renameRes.status).toBe(200);

      const Page = crowi.model('Page');
      const stub = await Page.findOne({ path: `${PATH_PREFIX}rename-source` }).lean();
      expect(stub).not.toBeNull();
      expect(stub?.redirectTo).toBe(`${PATH_PREFIX}rename-dest`);

      const res = await claim(claimantToken, (stub?._id as { toString(): string }).toString());
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(false);
    });

    it('claiming the SAME _id after a plain rename (no redirect stub) still grants access — the shared link survives the rename', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}renamed-source`, '# body', GRANT_RESTRICTED);
      const renameRes = await request(app)
        .post('/api/pages/rename')
        .set(authHeaders(ownerToken))
        .set('Idempotency-Key', idempotencyKey())
        .send({ page_id: page._id, new_path: `${PATH_PREFIX}renamed-dest` });
      expect(renameRes.status).toBe(200);

      const res = await claim(claimantToken, page._id);
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(true);
    });
  });

  describe('scope / web-session boundaries (RFC-0010)', () => {
    it('403 INSUFFICIENT_SCOPE for a pages:read-only OAuth token', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}scope-oauth-read`, '# body', GRANT_RESTRICTED);
      const scoped = await createTestUser({ name: 'Link Access Scope Read', username: 'linkAccessScopeRead', email: 'link-access-scope-read@example.com' });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['pages:read'], clientId: 'crowi-cli' });

      const res = await claim(oauthToken, page._id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(await grantedUsersOf(page._id)).not.toContain(scoped.user._id.toString());
    });

    it('403 PAGE_NOT_GRANTED (web-session-only) for a pages:write OAuth token, even though scope is satisfied', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}scope-oauth-write`, '# body', GRANT_RESTRICTED);
      const scoped = await createTestUser({ name: 'Link Access Scope Write', username: 'linkAccessScopeWrite', email: 'link-access-scope-write@example.com' });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['pages:write'], clientId: 'crowi-cli' });

      const res = await claim(oauthToken, page._id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await grantedUsersOf(page._id)).not.toContain(scoped.user._id.toString());
    });

    it('403 PAGE_NOT_GRANTED (web-session-only) for a pages:write PAT', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}scope-pat-write`, '# body', GRANT_RESTRICTED);
      const scoped = await createTestUser({ name: 'Link Access Scope PAT', username: 'linkAccessScopePat', email: 'link-access-scope-pat@example.com' });
      const created = await request(app)
        .post('/api/me/access-tokens')
        .set(authHeaders(scoped.accessToken))
        .send({ name: 'link-access-pat', scopes: ['pages:write'] });
      expect(created.status).toBe(201);
      const patToken = created.body.token as string;

      const res = await claim(patToken, page._id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAGE_NOT_GRANTED');
      expect(await grantedUsersOf(page._id)).not.toContain(scoped.user._id.toString());
    });

    it("30 rejected non-web (OAuth) requests do not consume the same user's web rate-limit bucket", async () => {
      // Dedicated fresh user: this test intentionally drives the limiter's
      // per-user bucket near its budget, so it must not share an identity
      // with any other test in this file.
      const bucketUser = await createTestUser({
        name: 'Link Access Bucket Isolation',
        username: 'linkAccessBucketIsolation',
        email: 'link-access-bucket-isolation@example.com',
      });
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}bucket-isolation`, '# body', GRANT_RESTRICTED);
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: bucketUser.user, scopes: ['pages:write'], clientId: 'crowi-cli' });

      // Limit is 30/min/user. The web-session guard runs BEFORE the rate
      // limiter (registration order), so these 30 non-web rejections must
      // never reach — let alone count against — the limiter.
      const rejections = await Promise.all(Array.from({ length: 30 }, () => claim(oauthToken, page._id)));
      expect(rejections.every((r) => r.status === 403)).toBe(true);

      // The SAME user's real web session must still be processed normally
      // (200, not 429) right after.
      const webRes = await claim(bucketUser.accessToken, page._id);
      expect(webRes.status).toBe(200);
      expect(webRes.body.granted).toBe(true);
    });
  });

  describe('rate limiting (30 req/min/user)', () => {
    it('429s with Retry-After once the per-user budget is exceeded; a different user is unaffected', async () => {
      // Dedicated fresh user: this test intentionally exhausts the
      // limiter's per-user bucket, so it must not share an identity with
      // any other test in this file (would make later assertions flaky).
      const rateLimitedUser = await createTestUser({
        name: 'Link Access Rate Limited',
        username: 'linkAccessRateLimited',
        email: 'link-access-rate-limited@example.com',
      });
      const otherUser = await createTestUser({
        name: 'Link Access Rate Other',
        username: 'linkAccessRateOther',
        email: 'link-access-rate-other@example.com',
      });
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}rate-limit`, '# body', GRANT_RESTRICTED);

      // 2*budget+1 concurrent requests span at most two fixed windows —
      // by pigeonhole, one window receives >30 hits wherever the window
      // boundary falls (same technique — and the same flakiness rationale
      // — as autocomplete.test.ts's rate-limit test).
      const responses = await Promise.all(Array.from({ length: 61 }, () => claim(rateLimitedUser.accessToken, page._id)));
      expect(responses.every((r) => r.status === 200 || r.status === 429)).toBe(true);

      const limited = responses.find((r) => r.status === 429);
      expect(limited).toBeDefined();
      expect(limited?.body.error).toBe('rate_limited');
      expect(typeof limited?.body.retryAfterSeconds).toBe('number');
      expect(limited?.headers['retry-after']).toBeDefined();

      const otherRes = await claim(otherUser.accessToken, page._id);
      expect(otherRes.status).toBe(200);
    });
  });

  describe('search reindex integration (indexPageInSearchById)', () => {
    it('reindexes the page (with the new grantee reflected) only when a write actually happens', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}reindex-on-grant`, '# body', GRANT_RESTRICTED);
      const driver = buildMockSearchDriver();

      await withMockSearchDriver(driver, async () => {
        const res = await claim(claimantToken, page._id);
        expect(res.status).toBe(200);
        expect(res.body.granted).toBe(true);

        // The reindex is a `crowi.trackSideEffect`-tracked fire-and-forget
        // (not awaited by the handler before it responds) — drain it
        // WHILE the mock driver is still swapped in, otherwise the real
        // index write could land after `withMockSearchDriver` restores the
        // original driver and be lost to this assertion.
        await crowi.drainSideEffects();
      });

      expect(driver.indexed).toHaveLength(1);
      expect(driver.indexed[0]?.meta?.granted_users).toContain(claimantId);
    });

    it('does not reindex on a no-op pass-through (public page)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}no-reindex-public`, '# body', GRANT_PUBLIC);
      const driver = buildMockSearchDriver();

      await withMockSearchDriver(driver, async () => {
        const res = await claim(claimantToken, page._id);
        expect(res.status).toBe(200);
        expect(res.body.granted).toBe(false);

        await crowi.drainSideEffects();
      });

      expect(driver.indexed).toHaveLength(0);
    });

    it('does not trigger backlink registration (no page event / write amplification)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}no-event-amplification`, '# body', GRANT_RESTRICTED);
      const Backlink = crowi.model('Backlink');
      const backlinkSpy = jest.spyOn(Backlink, 'createBySavedPage');

      try {
        const res = await claim(claimantToken, page._id);
        expect(res.status).toBe(200);
        expect(res.body.granted).toBe(true);

        await crowi.drainSideEffects();
        expect(backlinkSpy).not.toHaveBeenCalled();
      } finally {
        backlinkSpy.mockRestore();
      }
    });

    it('still returns 200 (granted: true) even if the search reindex helper itself throws', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}reindex-throws`, '# body', GRANT_RESTRICTED);
      const throwingDriver: SearchDriver = {
        async index() {
          throw new Error('search cluster down');
        },
        async remove() {},
        async query() {
          return { total: 0, hits: [] };
        },
      };

      await withMockSearchDriver(throwingDriver, async () => {
        const res = await claim(claimantToken, page._id);
        expect(res.status).toBe(200);
        expect(res.body.granted).toBe(true);
      });
    });
  });

  describe('list visibility (GET /pages/list)', () => {
    it('a claimed GRANT_RESTRICTED page is invisible before the claim and visible after', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}list-visibility`, '# body', GRANT_RESTRICTED);
      const viewer = await createTestUser({
        name: 'Link Access List Visibility',
        username: 'linkAccessListVisibility',
        email: 'link-access-list-visibility@example.com',
      });

      const before = await request(app).get('/api/pages/list').query({ path: '/' }).set(authHeaders(viewer.accessToken));
      expect(before.status).toBe(200);
      expect((before.body.pages as { _id: string }[]).map((p) => p._id)).not.toContain(page._id);

      const claimRes = await claim(viewer.accessToken, page._id);
      expect(claimRes.status).toBe(200);

      const after = await request(app).get('/api/pages/list').query({ path: '/' }).set(authHeaders(viewer.accessToken));
      expect(after.status).toBe(200);
      expect((after.body.pages as { _id: string }[]).map((p) => p._id)).toContain(page._id);
    });
  });

  describe('setPageGrant reindex symmetry (§6)', () => {
    it('reindexes the page after a grant reset, reflecting the post-reset grantedUsers (link-invited co-editor drops out of ES)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}grant-reset-reindex`, '# body', GRANT_RESTRICTED);
      const claimRes = await claim(claimantToken, page._id);
      expect(claimRes.body.granted).toBe(true);

      const driver = buildMockSearchDriver();
      await withMockSearchDriver(driver, async () => {
        const res = await request(app).put('/api/pages/grant').set(authHeaders(ownerToken)).send({ page_id: page._id, grant: GRANT_OWNER });
        expect(res.status).toBe(200);

        // Drain the tracked fire-and-forget reindex while the mock driver
        // is still swapped in (see the comment in the claim-endpoint
        // reindex test above).
        await crowi.drainSideEffects();
      });

      expect(driver.indexed.length).toBeGreaterThanOrEqual(1);
      const last = driver.indexed[driver.indexed.length - 1];
      expect(last?.meta?.granted_users).not.toContain(claimantId);
      expect(last?.meta?.granted_users).toContain(ownerId);
    });
  });

  describe('soft-delete ES remove', () => {
    it('removes the page from the search index on soft-delete', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}soft-delete-remove`, '# body', GRANT_PUBLIC);
      const driver = buildMockSearchDriver();

      await withMockSearchDriver(driver, async () => {
        const res = await request(app).delete('/api/pages').set(authHeaders(ownerToken)).send({ page_id: page._id });
        expect(res.status).toBe(200);

        // Drain the tracked fire-and-forget reindex while the mock driver
        // is still swapped in (see the comment in the claim-endpoint
        // reindex test above).
        await crowi.drainSideEffects();
      });

      expect(driver.removed).toContain(page._id);
    });
  });
});
