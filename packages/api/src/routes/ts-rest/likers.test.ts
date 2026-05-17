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

/**
 * RFC-0005 Phase 3 — `GET /api/v2/pages/:id/likers`.
 *
 * Covers the three required perspectives: a normal liker list (with
 * pagination + `likedAt` enrichment), the empty case, and the
 * permission gate (malformed id / missing / not-granted).
 */
describe('Routes /api/v2/pages/:id/likers (ts-rest getLikers)', () => {
  const PATH_PREFIX = '/ts-rest-likers/';
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let liker1: Awaited<ReturnType<typeof createTestUser>>;
  let liker2: Awaited<ReturnType<typeof createTestUser>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    [owner, liker1, liker2, outsider] = await Promise.all([
      createTestUser({ name: 'Likers Owner', username: 'likersOwner', email: 'likers-owner@example.com' }),
      createTestUser({ name: 'Likers One', username: 'likersOne', email: 'likers-one@example.com' }),
      createTestUser({ name: 'Likers Two', username: 'likersTwo', email: 'likers-two@example.com' }),
      createTestUser({ name: 'Likers Outsider', username: 'likersOutsider', email: 'likers-outsider@example.com' }),
    ]);
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
  });

  const createPage = async (suffix: string, opts: { grant?: number } = {}) => {
    const path = `${PATH_PREFIX}${suffix}`;
    const res = await request(app)
      .post('/api/v2/pages')
      .set(authHeaders(owner.accessToken))
      .send({ path, body: '# likers', ...(opts.grant ? { grant: opts.grant } : {}) });
    expect(res.status).toBe(200);
    return res.body.page._id as string;
  };

  const likePage = async (pageId: string, token: string) => {
    const res = await request(app).post('/api/v2/pages/like').set(authHeaders(token)).send({ page_id: pageId });
    expect(res.status).toBe(200);
  };

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/likers').set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 400 INVALID_PAGE_ID when :id is not a 24-char hex string', async () => {
    const res = await request(app).get('/api/v2/pages/not-a-valid-id/likers').set(authHeaders(owner.accessToken));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGE_ID');
  });

  it('returns 404 PAGE_NOT_FOUND for a well-formed but nonexistent page id', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/likers').set(authHeaders(owner.accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns 404 PAGE_NOT_FOUND when the caller lacks read permission (does not leak existence)', async () => {
    const pageId = await createPage('private', { grant: 4 });

    const res = await request(app).get(`/api/v2/pages/${pageId}/likers`).set(authHeaders(outsider.accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns an empty list with totalCount 0 when nobody has liked the page', async () => {
    const pageId = await createPage('empty');

    const res = await request(app).get(`/api/v2/pages/${pageId}/likers`).set(authHeaders(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.totalCount).toBe(0);
  });

  it('returns the liker list with public profile fields and a likedAt timestamp', async () => {
    const pageId = await createPage('liked');
    await likePage(pageId, liker1.accessToken);

    const res = await request(app).get(`/api/v2/pages/${pageId}/likers`).set(authHeaders(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.users).toHaveLength(1);

    const entry = res.body.users[0];
    expect(entry.id).toBe(liker1.user._id.toString());
    expect(entry.username).toBe('likersOne');
    expect(entry.displayName).toBe('Likers One');
    expect('avatarUrl' in entry).toBe(true);
    // like via the API records an ACTION_LIKE Activity, so likedAt is present.
    expect(entry.likedAt).not.toBeNull();
    expect(Number.isNaN(new Date(entry.likedAt).getTime())).toBe(false);
  });

  it('caps the returned list with `limit` while totalCount stays full', async () => {
    const pageId = await createPage('paginated');
    await likePage(pageId, liker1.accessToken);
    await likePage(pageId, liker2.accessToken);

    const res = await request(app).get(`/api/v2/pages/${pageId}/likers`).query({ limit: 1 }).set(authHeaders(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.users).toHaveLength(1);
  });

  it('lets any user with read access view the liker list (like list is not private)', async () => {
    const pageId = await createPage('public-readable');
    await likePage(pageId, liker1.accessToken);

    const res = await request(app).get(`/api/v2/pages/${pageId}/likers`).set(authHeaders(liker2.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(1);
  });
});
