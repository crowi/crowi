import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';
import type { UserDocument } from 'src/models/user';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

interface CreateTestUserInput {
  name: string;
  username: string;
  email: string;
  admin?: boolean;
}

const createTestUser = async (info: CreateTestUserInput): Promise<{ user: UserDocument; accessToken: string }> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [info])) as UserDocument[];
  user.status = User.STATUS_ACTIVE;
  user.admin = !!info.admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

const createPlainUser = async (info: CreateTestUserInput): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [info])) as UserDocument[];
  user.status = User.STATUS_ACTIVE;
  await user.save();
  return user;
};

const clearUsers = async () => {
  const User = crowi.model('User');
  // Wipe everything between describe blocks so pagination math is predictable.
  await User.deleteMany({});
};

describe('Routes /api/v2/admin/users (ts-rest)', () => {
  describe('GET /api/v2/admin/users', () => {
    let adminToken: string;
    let userToken: string;

    beforeAll(async () => {
      await clearUsers();

      const admin = await createTestUser({
        name: 'List Admin',
        username: 'listAdmin',
        email: 'list-admin@example.com',
        admin: true,
      });
      adminToken = admin.accessToken;

      const normal = await createTestUser({
        name: 'List Normal',
        username: 'listNormal',
        email: 'list-normal@example.com',
        admin: false,
      });
      userToken = normal.accessToken;

      // Distinct users for search / pagination scenarios.
      await createPlainUser({ name: 'Alice Smith', username: 'alice', email: 'alice@example.com' });
      await createPlainUser({ name: 'Bob Jones', username: 'bob', email: 'bob@sample.com' });
      await createPlainUser({ name: 'Carol Carter', username: 'carol', email: 'carol@example.com' });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/users');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/users').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the full user list for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/users').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.users)).toBe(true);
      expect(res.body.users.length).toBe(5);
      expect(res.body.pager).toMatchObject({
        page: 1,
        pagesCount: 1,
        total: 5,
        previous: null,
        next: null,
        previousDots: false,
        nextDots: false,
      });
      expect(res.body.pager.pages).toEqual([1]);
    });

    it('omits sensitive fields (password / apiToken / googleId / githubId)', async () => {
      const res = await request(app).get('/api/v2/admin/users').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      for (const u of res.body.users) {
        expect(u).not.toHaveProperty('password');
        expect(u).not.toHaveProperty('apiToken');
        expect(u).not.toHaveProperty('googleId');
        expect(u).not.toHaveProperty('githubId');
      }
    });

    it('filters by free-text query (q) on username/name/email', async () => {
      const res = await request(app).get('/api/v2/admin/users').query({ q: 'alice' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.users[0].username).toBe('alice');
      expect(res.body.pager.total).toBe(1);
    });

    it("treats space in q as '|' for regex OR matching (legacy parity)", async () => {
      // 'alice bob' -> regex 'alice|bob' (only first space replaced) — both
      // alice@example.com and bob@sample.com should match.
      const res = await request(app).get('/api/v2/admin/users').query({ q: 'alice bob' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      const usernames = (res.body.users as Array<{ username: string }>).map((u) => u.username).sort();
      expect(usernames).toEqual(['alice', 'bob']);
    });

    it('matches the email field, not just username/name', async () => {
      const res = await request(app).get('/api/v2/admin/users').query({ q: 'sample.com' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.users[0].email).toBe('bob@sample.com');
    });

    it('respects the page query parameter', async () => {
      // limit=2 → 5 users → 3 pages → page 2 has indices 2..3
      const res = await request(app).get('/api/v2/admin/users').query({ page: 2, limit: 2 }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(2);
      expect(res.body.pager).toMatchObject({
        page: 2,
        pagesCount: 3,
        total: 5,
        previous: 1,
        next: 3,
      });
    });

    it('returns an empty list when q matches nothing', async () => {
      const res = await request(app).get('/api/v2/admin/users').query({ q: 'no-such-user-xyz' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users).toEqual([]);
      expect(res.body.pager.total).toBe(0);
    });
  });

  describe('GET /api/v2/admin/users/search', () => {
    let adminToken: string;
    let userToken: string;

    beforeAll(async () => {
      await clearUsers();

      const admin = await createTestUser({
        name: 'Search Admin',
        username: 'searchAdmin',
        email: 'search-admin@example.com',
        admin: true,
      });
      adminToken = admin.accessToken;

      const normal = await createTestUser({
        name: 'Search Normal',
        username: 'searchNormal',
        email: 'search-normal@example.com',
        admin: false,
      });
      userToken = normal.accessToken;

      await createPlainUser({ name: 'Dave', username: 'dave', email: 'dave@example.com' });
      await createPlainUser({ name: 'Eve', username: 'eve', email: 'eve@example.org' });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/users/search').query({ email: 'dave' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/users/search').query({ email: 'dave' }).set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when email param is missing', async () => {
      const res = await request(app).get('/api/v2/admin/users/search').set(authHeaders(adminToken));
      expect(res.status).toBe(400);
    });

    it('returns email-substring matches for an admin', async () => {
      const res = await request(app).get('/api/v2/admin/users/search').query({ email: 'example.com' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      const emails = (res.body.users as Array<{ email: string }>).map((u) => u.email).sort();
      // search-admin@example.com, search-normal@example.com, dave@example.com
      expect(emails).toEqual(['dave@example.com', 'search-admin@example.com', 'search-normal@example.com']);
    });

    it('omits sensitive fields in the search response', async () => {
      const res = await request(app).get('/api/v2/admin/users/search').query({ email: 'dave' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      for (const u of res.body.users) {
        expect(u).not.toHaveProperty('password');
        expect(u).not.toHaveProperty('apiToken');
        expect(u).not.toHaveProperty('googleId');
        expect(u).not.toHaveProperty('githubId');
      }
    });
  });
});
