import { Types } from 'mongoose';
import request from 'supertest';

import { STATUS_RENAMING } from 'src/models/page';
import { encodeCursor } from 'src/service/page-history/read';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';

describe('GET /api/pages/:pageId/history', () => {
  const PATH_PREFIX = '/hono-page-history-test/';
  let ownerToken: string;
  let readerToken: string;
  let owner;
  let reader;

  beforeAll(async () => {
    const ownerResult = await createTestUser({ name: 'History Owner', username: 'honoHistoryOwner', email: 'hono-history-owner@example.com' });
    const readerResult = await createTestUser({ name: 'History Reader', username: 'honoHistoryReader', email: 'hono-history-reader@example.com' });
    ownerToken = ownerResult.accessToken;
    readerToken = readerResult.accessToken;
    owner = ownerResult.user;
    reader = readerResult.user;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const pages = await Page.find({ path: { $regex: `^${PATH_PREFIX}` } })
      .select('_id')
      .lean();
    const pageIds = pages.map((page) => page._id);
    await Promise.all([
      Page.deleteMany({ _id: { $in: pageIds } }),
      Revision.deleteMany({ page: { $in: pageIds } }),
      crowi.model('PageHistoryEvent').deleteMany({ page: { $in: pageIds } }),
    ]);
    jest.restoreAllMocks();
  });

  it('wires the route and returns the merged timeline', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}success`, '# body');

    const res = await request(app).get(`/api/pages/${page._id}/history`).set(authHeaders(ownerToken));

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ type: 'content_revision', sequence: 1 });
  });

  it('returns 404 before querying history when the caller has no grant', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}private`, '# private', 4);
    const revisionFind = jest.spyOn(crowi.model('Revision'), 'find');
    const eventFind = jest.spyOn(crowi.model('PageHistoryEvent'), 'find');

    const res = await request(app).get(`/api/pages/${page._id}/history`).set(authHeaders(readerToken));

    expect(res.status).toBe(404);
    expect(revisionFind).not.toHaveBeenCalled();
    expect(eventFind).not.toHaveBeenCalled();
  });

  it('returns 404 for a transitional page before querying history', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}renaming`, '# body');
    await crowi.model('Page').updateOne({ _id: page._id }, { $set: { status: STATUS_RENAMING } });
    const revisionFind = jest.spyOn(crowi.model('Revision'), 'find');

    const res = await request(app).get(`/api/pages/${page._id}/history`).set(authHeaders(ownerToken));

    expect(res.status).toBe(404);
    expect(revisionFind).not.toHaveBeenCalled();
  });

  it('classifies an authorization lookup failure as 500 with pageId', async () => {
    const pageId = String(new Types.ObjectId());
    jest.spyOn(crowi.model('Page'), 'findOne').mockReturnValueOnce({
      select() {
        return this;
      },
      lean() {
        return this;
      },
      exec() {
        return Promise.reject(new Error('mongo unavailable'));
      },
    } as never);

    const res = await request(app).get(`/api/pages/${pageId}/history`).set(authHeaders(ownerToken));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', pageId });
  });

  it('returns 403 for a token without pages:read scope', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}scope`, '# body');
    const token = createJwtUtil(crowi).signOauthAccessToken({ user: owner, scopes: ['profile:read'], clientId: 'crowi-cli' });

    const res = await request(app).get(`/api/pages/${page._id}/history`).set(authHeaders(token));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('rejects a malformed cursor before the authorization query', async () => {
    const pageId = String(new Types.ObjectId());
    const authorizationFind = jest.spyOn(crowi.model('Page'), 'findOne');

    const res = await request(app).get(`/api/pages/${pageId}/history`).query({ cursor: 'not-a-cursor' }).set(authHeaders(ownerToken));

    expect(res.status).toBe(400);
    expect(authorizationFind).not.toHaveBeenCalled();
  });

  it('rejects a cursor bound to another page', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}cursor-page`, '# body');
    const cursor = encodeCursor({
      v: 1,
      pageId: String(new Types.ObjectId()),
      upper: 1,
      region: 'sequenced',
      boundary: new Date(0).toISOString(),
      after: { sequence: 1, kindRank: 0, id: String(new Types.ObjectId()) },
    });

    const res = await request(app).get(`/api/pages/${page._id}/history`).query({ cursor }).set(authHeaders(ownerToken));

    expect(res.status).toBe(400);
  });

  it('re-checks authorization on continuation', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}continuation`, '# v1');
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const pageDoc = await Page.findById(page._id);
    const revision = await Revision.prepareRevision(pageDoc, '# v2', owner, { format: 'markdown' });
    await Page.pushRevision(pageDoc, revision, owner);

    const first = await request(app).get(`/api/pages/${page._id}/history`).query({ limit: 1 }).set(authHeaders(readerToken));
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    await Page.updateOne({ _id: page._id }, { $set: { grant: Page.GRANT_OWNER } });
    const second = await request(app).get(`/api/pages/${page._id}/history`).query({ limit: 1, cursor: first.body.nextCursor }).set(authHeaders(readerToken));

    expect(second.status).toBe(404);
  });

  // AC-11 — cursors are minted with the normalised (lowercase) id, so an
  // uppercase-hex pageId in the URL must still match on continuation, not
  // just on the first page.
  it('AC-11: reads the second page with an uppercase-hex pageId in the URL', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}uppercase-id`, '# v1');
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const pageDoc = await Page.findById(page._id);
    const revision = await Revision.prepareRevision(pageDoc, '# v2', owner, { format: 'markdown' });
    await Page.pushRevision(pageDoc, revision, owner);
    const upperPageId = String(page._id).toUpperCase();

    const first = await request(app).get(`/api/pages/${upperPageId}/history`).query({ limit: 1 }).set(authHeaders(ownerToken));
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(`/api/pages/${upperPageId}/history`).query({ limit: 1, cursor: first.body.nextCursor }).set(authHeaders(ownerToken));

    expect(second.status).toBe(200);
    expect(second.body.entries).toHaveLength(1);
  });
});
