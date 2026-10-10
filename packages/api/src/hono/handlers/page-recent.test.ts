import { Types } from 'mongoose';
import type { PageDocument } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import * as pageResponseModule from 'src/util/page-response';
import request from 'supertest';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BASE = `/rc-${RUN}`;
const createdIds: Types.ObjectId[] = [];
const createdUsers: string[] = [];

const GRANT_PUBLIC = 1;
const GRANT_RESTRICTED = 2;
const GRANT_SPECIFIED = 3;
const GRANT_OWNER = 4;

interface FixtureOptions {
  grant?: number;
  grantedUsers?: Types.ObjectId[];
  status?: string;
  updatedAt?: Date;
  lastUpdateUser?: Types.ObjectId;
  redirectTo?: string;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

// Creates through the model (real revision), then overwrites the fields the
// public API would not let a test set directly.
const createRecentFixture = async (path: string, creator: UserDocument, options: FixtureOptions = {}): Promise<PageDocument> => {
  const Page = crowi.model('Page');
  const page = (await Page.createPage(path, `# ${path}`, creator, { grant: GRANT_PUBLIC })) as PageDocument;
  createdIds.push(page._id as Types.ObjectId);
  const set: Record<string, unknown> = { updatedAt: options.updatedAt ?? day(1) };
  if (options.grant !== undefined) set.grant = options.grant;
  if (options.grantedUsers) set.grantedUsers = options.grantedUsers;
  if (options.status) set.status = options.status;
  if (options.lastUpdateUser) set.lastUpdateUser = options.lastUpdateUser;
  if (options.redirectTo) set.redirectTo = options.redirectTo;
  await Page.updateOne({ _id: page._id }, { $set: set });
  return page;
};

const cleanupRecentFixtures = async () => {
  await crowi.model('Page').deleteMany({ _id: { $in: createdIds } });
  await crowi.model('Revision').deleteMany({ path: new RegExp(`^(/trash)?${BASE}/`) });
  createdIds.length = 0;
};

const list = (token: string, query: Record<string, string | number | boolean>) => request(app).get('/api/pages/list').set(authHeaders(token)).query(query);

const makeUser = async (tag: string) => {
  const info = await createTestUser({ name: `rc ${tag}`, username: `rc${RUN}${tag}`, email: `rc-${RUN}-${tag}@example.com` });
  createdUsers.push(info.user.email);
  return info;
};

describe('Routes /api/pages/list path_prefix (literal prefix recent listing)', () => {
  let viewer: UserDocument;
  let viewerToken: string;
  let other: UserDocument;

  beforeAll(async () => {
    ({ user: viewer, accessToken: viewerToken } = await makeUser('v'));
    ({ user: other } = await makeUser('o'));
  });

  afterEach(cleanupRecentFixtures);

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: { $in: createdUsers } });
  });

  it('literal prefix includes its starting page before paging', async () => {
    await createRecentFixture(`${BASE}/team/`, viewer, { updatedAt: day(10) });
    await createRecentFixture(`${BASE}/team/a`, viewer, { updatedAt: day(5) });
    await createRecentFixture(`${BASE}/team/b`, viewer, { updatedAt: day(4) });

    const first = await list(viewerToken, { path_prefix: `${BASE}/team/`, limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.pages.map((p: { path: string }) => p.path)).toEqual([`${BASE}/team/`]);
    expect(first.body.total).toBe(3);
    expect(first.body.portalPage).toBeNull();
    expect(first.body.contentPage ?? null).toBeNull();
    expect(first.body.appliedPathPrefix).toBe(`${BASE}/team/`);
    expect(first.body.pager).toEqual({ prev: null, next: 1, offset: 0 });

    const second = await list(viewerToken, { path_prefix: `${BASE}/team/`, limit: 1, offset: 1 });
    expect(second.body.pages.map((p: { path: string }) => p.path)).toEqual([`${BASE}/team/a`]);
    expect(second.body.total).toBe(3);
  });

  it('literal prefix boundary matrix', async () => {
    const paths = [
      `${BASE}/team`,
      `${BASE}/team/`,
      `${BASE}/team/x`,
      `${BASE}/teamwork`,
      `${BASE}/Team/up`,
      `${BASE}/日本/語`,
      `${BASE}/a.b`,
      `${BASE}/aXb`,
      `${BASE}/q[1]+*?$\\z`,
      `${BASE}/qq`,
    ];
    for (const [i, p] of paths.entries()) {
      await createRecentFixture(p, viewer, { updatedAt: day(i + 1) });
    }
    const paths_of = async (prefix: string) => {
      const res = await list(viewerToken, { path_prefix: prefix, limit: 100 });
      expect(res.status).toBe(200);
      expect(res.body.appliedPathPrefix).toBe(prefix);
      return res.body.pages.map((p: { path: string }) => p.path).sort();
    };

    expect(await paths_of(`${BASE}/team`)).toEqual([`${BASE}/team`, `${BASE}/team/`, `${BASE}/team/x`, `${BASE}/teamwork`].sort());
    expect(await paths_of(`${BASE}/team/`)).toEqual([`${BASE}/team/`, `${BASE}/team/x`].sort());
    expect(await paths_of(`${BASE}/日本`)).toEqual([`${BASE}/日本/語`]);
    expect(await paths_of(`${BASE}/a.b`)).toEqual([`${BASE}/a.b`]);
    expect(await paths_of(`${BASE}/q[1]+*?$\\`)).toEqual([`${BASE}/q[1]+*?$\\z`]);
    expect(await paths_of(`${BASE}/Team`)).toEqual([`${BASE}/Team/up`]);

    const root = await list(viewerToken, { path_prefix: '/', limit: 1 });
    expect(root.status).toBe(200);
    expect(root.body.appliedPathPrefix).toBe('/');
    expect(root.body.total).toBeGreaterThanOrEqual(paths.length);
  });

  it('rejects prefix combinations before database reads', async () => {
    const Page = crowi.model('Page');
    const findSpy = jest.spyOn(Page, 'find');
    const countSpy = jest.spyOn(Page, 'countDocuments');
    try {
      const bad = async (query: Record<string, string | number | boolean>, message: string) => {
        const res = await list(viewerToken, { path_prefix: '/x', ...query });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toBe(message);
      };
      const combo = 'path_prefix cannot be combined with path, user, or revision_id';
      await bad({ path: '/a' }, combo);
      await bad({ path: '' }, combo);
      await bad({ user: '' }, combo);
      await bad({ user: String(new Types.ObjectId()) }, combo);
      await bad({ revision_id: '' }, combo);
      await bad({ path: '/a', user: 'u', revision_id: 'r', include_deleted: true, limit: 0 }, combo);
      await bad({ include_deleted: true, limit: 0 }, 'path_prefix does not support include_deleted=true');
      await bad({ limit: 0, offset: -1 }, 'limit must be an integer between 1 and 100');
      await bad({ limit: 101 }, 'limit must be an integer between 1 and 100');
      await bad({ limit: 1.5 }, 'limit must be an integer between 1 and 100');
      await bad({ offset: -1 }, 'offset must be an integer between 0 and 2147483647');
      await bad({ offset: 2147483648 }, 'offset must be an integer between 0 and 2147483647');
      await bad({ offset: 0.5 }, 'offset must be an integer between 0 and 2147483647');
      expect(findSpy).not.toHaveBeenCalled();
      expect(countSpy).not.toHaveBeenCalled();

      const schemaLevel = await list(viewerToken, { path_prefix: '' });
      expect(schemaLevel.status).toBe(400);
      const bare = await list(viewerToken, { path_prefix: 'team' });
      expect(bare.status).toBe(400);
    } finally {
      findSpy.mockRestore();
      countSpy.mockRestore();
    }

    const edge = await list(viewerToken, { path_prefix: `${BASE}/none`, limit: 100, offset: 2147483647, include_deleted: false });
    expect(edge.status).toBe(200);
    expect(edge.body.pages).toEqual([]);
  });

  it('prefix query or enrichment failure returns 500 without confirmation', async () => {
    const Page = crowi.model('Page');
    await createRecentFixture(`${BASE}/f/one`, viewer);
    const secret = 'secret-mongo-detail';

    const findSpy = jest.spyOn(Page, 'find').mockImplementationOnce(() => {
      throw new Error(secret);
    });
    const failedFind = await list(viewerToken, { path_prefix: `${BASE}/f/` });
    findSpy.mockRestore();
    expect(failedFind.status).toBe(500);
    expect(failedFind.body.appliedPathPrefix).toBeUndefined();
    expect(JSON.stringify(failedFind.body)).not.toContain(secret);

    const countSpy = jest.spyOn(Page, 'countDocuments').mockImplementationOnce(() => {
      throw new Error(secret);
    });
    const failedCount = await list(viewerToken, { path_prefix: `${BASE}/f/` });
    countSpy.mockRestore();
    expect(failedCount.status).toBe(500);
    expect(JSON.stringify(failedCount.body)).not.toContain(secret);

    const enrichSpy = jest.spyOn(pageResponseModule, 'populatePageRelationData').mockRejectedValueOnce(new Error(secret));
    const failedEnrich = await list(viewerToken, { path_prefix: `${BASE}/f/` });
    enrichSpy.mockRestore();
    expect(failedEnrich.status).toBe(500);
    expect(JSON.stringify(failedEnrich.body)).not.toContain(secret);

    // Without a prefix the failure is the same 500, never an empty list.
    for (const query of [{}, { path: `${BASE}/f/` }, { path: '/' }]) {
      const spy = jest.spyOn(Page, 'countDocuments').mockImplementationOnce(() => {
        throw new Error(secret);
      });
      const res = await list(viewerToken, query);
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
  });

  it('prefix rows and total share the viewer predicate', async () => {
    const p = `${BASE}/vis`;
    await createRecentFixture(`${p}/hidden-newest`, other, { grant: GRANT_OWNER, grantedUsers: [other._id as Types.ObjectId], updatedAt: day(20) });
    await createRecentFixture(`${p}/other-draft`, other, { status: 'draft', updatedAt: day(19) });
    await createRecentFixture(`${p}/own-draft`, viewer, { status: 'draft', updatedAt: day(18) });
    await createRecentFixture(`${p}/restricted-no`, other, { grant: GRANT_RESTRICTED, grantedUsers: [other._id as Types.ObjectId], updatedAt: day(17) });
    await createRecentFixture(`${p}/restricted-yes`, other, {
      grant: GRANT_RESTRICTED,
      grantedUsers: [other._id as Types.ObjectId, viewer._id as Types.ObjectId],
      updatedAt: day(16),
    });
    await createRecentFixture(`${p}/specified-yes`, other, { grant: GRANT_SPECIFIED, grantedUsers: [viewer._id as Types.ObjectId], updatedAt: day(15) });
    await createRecentFixture(`${p}/owner-mine`, viewer, { grant: GRANT_OWNER, grantedUsers: [viewer._id as Types.ObjectId], updatedAt: day(14) });
    await createRecentFixture(`${p}/deleted`, viewer, { status: 'deleted', updatedAt: day(13) });
    await createRecentFixture(`${p}/redirect`, viewer, { redirectTo: `${p}/public`, updatedAt: day(12) });
    await createRecentFixture(`${p}/public`, viewer, { updatedAt: day(11) });

    const res = await list(viewerToken, { path_prefix: `${p}/`, limit: 100 });
    expect(res.status).toBe(200);
    const paths = res.body.pages.map((x: { path: string }) => x.path);
    expect(paths).toEqual([`${p}/own-draft`, `${p}/restricted-yes`, `${p}/specified-yes`, `${p}/owner-mine`, `${p}/public`]);
    expect(res.body.total).toBe(5);

    const limited = await list(viewerToken, { path_prefix: `${p}/`, limit: 1 });
    expect(limited.body.pages.map((x: { path: string }) => x.path)).toEqual([`${p}/own-draft`]);
    expect(limited.body.total).toBe(5);
  });

  it('trash prefix keeps normal lifecycle and auth is enforced', async () => {
    const t = `/trash${BASE}`;
    await createRecentFixture(`${t}/live`, viewer, { updatedAt: day(3) });
    await createRecentFixture(`${t}/gone`, viewer, { status: 'deleted', updatedAt: day(4) });

    const res = await list(viewerToken, { path_prefix: `${t}/` });
    expect(res.status).toBe(200);
    expect(res.body.pages.map((x: { path: string }) => x.path)).toEqual([`${t}/live`]);

    const anon = await request(app)
      .get('/api/pages/list')
      .query({ path_prefix: `${t}/` });
    expect(anon.status).toBe(401);

    const PersonalAccessToken = crowi.model('PersonalAccessToken');
    const mint = async (scopes: string[]) => {
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId: viewer._id, name: `rc-${RUN}-${scopes.join('-')}`, scopes });
      return token as string;
    };
    const readToken = await mint(['pages:read']);
    const okRes = await request(app)
      .get('/api/pages/list')
      .set('Authorization', `Bearer ${readToken}`)
      .query({ path_prefix: `${t}/` });
    expect(okRes.status).toBe(200);
    expect(okRes.body.appliedPathPrefix).toBe(`${t}/`);

    const noScope = await mint(['bookmarks:read']);
    const denied = await request(app)
      .get('/api/pages/list')
      .set('Authorization', `Bearer ${noScope}`)
      .query({ path_prefix: `${t}/` });
    expect(denied.status).toBe(403);
    await PersonalAccessToken.deleteMany({ userId: viewer._id });
  });

  it('only successful prefix responses confirm the applied value', async () => {
    const empty = await list(viewerToken, { path_prefix: `${BASE}/nothing-here/` });
    expect(empty.status).toBe(200);
    expect(empty.body.pages).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.appliedPathPrefix).toBe(`${BASE}/nothing-here/`);

    const plain = await list(viewerToken, {});
    expect(plain.status).toBe(200);
    expect('appliedPathPrefix' in plain.body).toBe(false);
  });

  it('orders root and prefix by update time independently of creation time', async () => {
    const p = `${BASE}/ord`;
    await createRecentFixture(`${p}/old-created-new-updated`, viewer, { updatedAt: day(9), lastUpdateUser: other._id as Types.ObjectId });
    await createRecentFixture(`${p}/new-created-old-updated`, other, { updatedAt: day(2) });
    await createRecentFixture(`${p}/mid`, viewer, { updatedAt: day(5) });

    const res = await list(viewerToken, { path_prefix: `${p}/`, sort: 'updatedAt', order: 'desc' });
    expect(res.body.pages.map((x: { path: string }) => x.path)).toEqual([`${p}/old-created-new-updated`, `${p}/mid`, `${p}/new-created-old-updated`]);
    expect(res.body.pages[0].lastUpdateUser.username).toBe(other.username);

    const root = await list(viewerToken, { limit: 100 });
    const times = root.body.pages.map((x: { updatedAt: string }) => Date.parse(x.updatedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('offset pages cover fixed fixtures and may end in an empty next page', async () => {
    const p = `${BASE}/pg`;
    for (const i of [1, 2, 3, 4]) {
      await createRecentFixture(`${p}/${i}`, viewer, { updatedAt: day(i) });
    }
    const seen: string[] = [];
    for (const offset of [0, 2]) {
      const res = await list(viewerToken, { path_prefix: `${p}/`, limit: 2, offset });
      expect(res.body.total).toBe(4);
      seen.push(...res.body.pages.map((x: { path: string }) => x.path));
      expect(res.body.pager.next).toBe(offset + 2);
    }
    expect(seen).toEqual([`${p}/4`, `${p}/3`, `${p}/2`, `${p}/1`]);

    const tail = await list(viewerToken, { path_prefix: `${p}/`, limit: 2, offset: 4 });
    expect(tail.status).toBe(200);
    expect(tail.body.pages).toEqual([]);
    expect(tail.body.pager).toEqual({ prev: 2, next: null, offset: 4 });
    expect(tail.body.total).toBe(4);

    const beyond = await list(viewerToken, { path_prefix: `${p}/`, limit: 2, offset: 1000 });
    expect(beyond.body.pages).toEqual([]);
  });

  it('recent listing works without active search driver', async () => {
    await createRecentFixture(`${BASE}/ns/a`, viewer);
    const registries = crowi.pluginRegistries;
    if (!registries) throw new Error('pluginRegistries not initialized');
    const original = registries.active.search;
    registries.active.search = undefined;
    try {
      const rootRes = await list(viewerToken, { limit: 5 });
      expect(rootRes.status).toBe(200);
      const prefixRes = await list(viewerToken, { path_prefix: `${BASE}/ns/` });
      expect(prefixRes.status).toBe(200);
      expect(prefixRes.body.total).toBe(1);
    } finally {
      registries.active.search = original;
    }
  });
});
