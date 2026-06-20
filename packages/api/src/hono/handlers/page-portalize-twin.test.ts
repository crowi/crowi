/**
 * feature-update-pages-list-ux — coverage for:
 *   §4  contentPage resolution on a portal-path listing
 *   §6  /x ↔ /x/ twin-creation guard (create / draft / rename),
 *       with portalize-self (/x → /x/) allowed.
 */
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

const cleanupPathPrefix = (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const filter = { path: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } };
  return Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
};

// ---------------------------------------------------------------------------
// §4 — contentPage on a portal-path listing
// ---------------------------------------------------------------------------
describe('Routes /api/v2/pages/list (Hono listPages — §4 contentPage)', () => {
  const PATH_PREFIX = '/hono-page-contentpage-test/';
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    [{ accessToken }, { accessToken: otherAccessToken }] = await Promise.all([
      createTestUser({ name: 'ContentPage Test', username: 'contentPageTester', email: 'content-page-tester@example.com' }),
      createTestUser({ name: 'ContentPage Other', username: 'contentPageOther', email: 'content-page-other@example.com' }),
    ]);
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('returns contentPage for a /x/ listing when /x is a content page and no portal doc exists', async () => {
    const contentPath = `${PATH_PREFIX}has-content`;
    const portalPath = `${contentPath}/`;
    const headers = authHeaders(accessToken);

    const created = await createPageViaApi(accessToken, contentPath, '# content here');

    const res = await request(app).get('/api/v2/pages/list').set(headers).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).toBeNull();
    expect(res.body.contentPage).not.toBeNull();
    expect(res.body.contentPage._id).toBe(created._id);
    expect(res.body.contentPage.path).toBe(contentPath);

    // The content page must NOT also appear as a child row (it is the banner,
    // not a child) — same dedup as portalPage.
    const childPaths = (res.body.pages as Array<{ path: string }>).map((p) => p.path);
    expect(childPaths).not.toContain(contentPath);
  });

  it('returns contentPage=null when a real portal document exists at /x/ (exclusive with portalPage)', async () => {
    const portalPath = `${PATH_PREFIX}real-portal/`;
    const headers = authHeaders(accessToken);

    await createPageViaApi(accessToken, portalPath, '# Portal doc');

    const res = await request(app).get('/api/v2/pages/list').set(headers).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).not.toBeNull();
    expect(res.body.contentPage ?? null).toBeNull();
  });

  it('returns contentPage=null when neither a portal nor a content page exists at the path', async () => {
    const portalPath = `${PATH_PREFIX}implicit-folder/`;
    const headers = authHeaders(accessToken);

    // A child page makes `/x/` an implicit folder, but there is no `/x`
    // content page and no `/x/` portal.
    await createPageViaApi(accessToken, `${portalPath}child`, '# child');

    const res = await request(app).get('/api/v2/pages/list').set(headers).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.portalPage).toBeNull();
    expect(res.body.contentPage ?? null).toBeNull();
  });

  it("does not surface another user's OWNER-granted content page as contentPage", async () => {
    const contentPath = `${PATH_PREFIX}private-content`;
    const portalPath = `${contentPath}/`;

    // `other` owns a private (owner-only) page at /x; the requester cannot see
    // it, so the /x/ listing must not leak it as contentPage.
    await createPageViaApi(otherAccessToken, contentPath, '# secret', 4 /* GRANT_OWNER */);

    const res = await request(app).get('/api/v2/pages/list').set(authHeaders(accessToken)).query({ path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.contentPage ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §6 — /x ↔ /x/ twin guard
// ---------------------------------------------------------------------------
describe('Routes /api/v2/pages (Hono createPage — §6 twin guard)', () => {
  const PATH_PREFIX = '/hono-page-twin-create-test/';
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser({ name: 'TwinCreate Test', username: 'twinCreateTester', email: 'twin-create-tester@example.com' }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('refuses to create /x/ when /x already exists (400 PAGE_TWIN_EXISTS)', async () => {
    const contentPath = `${PATH_PREFIX}a`;
    const portalPath = `${contentPath}/`;
    const headers = authHeaders(accessToken);

    await createPageViaApi(accessToken, contentPath, '# content');

    const res = await request(app).post('/api/v2/pages').set(headers).send({ path: portalPath, body: '# portal' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_TWIN_EXISTS');

    // No page must have been created at the portal path.
    const Page = crowi.model('Page');
    expect(await Page.findOne({ path: portalPath })).toBeNull();
  });

  it('refuses to create /x when /x/ already exists (400 PAGE_TWIN_EXISTS)', async () => {
    const contentPath = `${PATH_PREFIX}b`;
    const portalPath = `${contentPath}/`;
    const headers = authHeaders(accessToken);

    await createPageViaApi(accessToken, portalPath, '# portal');

    const res = await request(app).post('/api/v2/pages').set(headers).send({ path: contentPath, body: '# content' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_TWIN_EXISTS');
  });

  it('allows creating /x when no twin exists', async () => {
    const contentPath = `${PATH_PREFIX}c`;
    const res = await request(app).post('/api/v2/pages').set(authHeaders(accessToken)).send({ path: contentPath, body: '# fresh' });
    expect(res.status).toBe(200);
    expect(res.body.page.path).toBe(contentPath);
  });
});

describe('Routes /api/v2/pages/drafts (Hono createDraft — §6 twin guard)', () => {
  const PATH_PREFIX = '/hono-page-twin-draft-test/';
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser({ name: 'TwinDraft Test', username: 'twinDraftTester', email: 'twin-draft-tester@example.com' }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('refuses to start a draft at /x/ when /x already exists (400 invalid_path)', async () => {
    const contentPath = `${PATH_PREFIX}a`;
    const portalPath = `${contentPath}/`;
    const headers = authHeaders(accessToken);

    await createPageViaApi(accessToken, contentPath, '# content');

    const res = await request(app).post('/api/v2/pages/drafts').set(headers).send({ path: portalPath });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_path');
    // The message names the conflicting twin so the user can act on it.
    expect(res.body.message).toContain(contentPath);
  });

  it('refuses to start a draft at /x when /x/ already exists (400 invalid_path)', async () => {
    const contentPath = `${PATH_PREFIX}b`;
    const portalPath = `${contentPath}/`;
    const headers = authHeaders(accessToken);

    await createPageViaApi(accessToken, portalPath, '# portal');

    const res = await request(app).post('/api/v2/pages/drafts').set(headers).send({ path: contentPath });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_path');
  });

  it('allows starting a draft at /x when no twin exists', async () => {
    const contentPath = `${PATH_PREFIX}c`;
    const res = await request(app).post('/api/v2/pages/drafts').set(authHeaders(accessToken)).send({ path: contentPath });
    expect(res.status).toBe(201);
    expect(res.body.pageId).toBeDefined();
  });
});

describe('Routes /api/v2/pages/rename (Hono renamePage — §6 twin guard)', () => {
  const PATH_PREFIX = '/hono-page-twin-rename-test/';
  let Page;
  let accessToken: string;

  beforeAll(async () => {
    Page = crowi.model('Page');
    ({ accessToken } = await createTestUser({ name: 'TwinRename Test', username: 'twinRenameTester', email: 'twin-rename-tester@example.com' }));
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  it('refuses to rename a page onto /x/ when an unrelated /x already exists (400 PAGE_TWIN_EXISTS)', async () => {
    const headers = authHeaders(accessToken);
    const existingTwin = `${PATH_PREFIX}target`;
    const fromPath = `${PATH_PREFIX}source`;
    const destPortal = `${existingTwin}/`;

    await createPageViaApi(accessToken, existingTwin, '# existing twin');
    const source = await createPageViaApi(accessToken, fromPath, '# source');

    const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: source._id, new_path: destPortal });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_TWIN_EXISTS');

    // Source must stay put.
    const sourceDoc = await Page.findById(source._id);
    expect(sourceDoc.path).toBe(fromPath);
  });

  it('ALLOWS portalize-self: renaming /x → /x/ (the twin /x is the page being moved)', async () => {
    const headers = authHeaders(accessToken);
    const contentPath = `${PATH_PREFIX}portalize-me`;
    const portalPath = `${contentPath}/`;

    const page = await createPageViaApi(accessToken, contentPath, '# portalize me');

    const res = await request(app).post('/api/v2/pages/rename').set(headers).send({ page_id: page._id, new_path: portalPath });
    expect(res.status).toBe(200);
    expect(res.body.page.path).toBe(portalPath);

    // The move leaves NO redirect at the old content path (§5).
    const redirect = await Page.findOne({ path: contentPath });
    expect(redirect).toBeNull();

    // And the page now lives at the portal path.
    const moved = await Page.findById(page._id);
    expect(moved.path).toBe(portalPath);
  });
});
