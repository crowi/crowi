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

describe('Routes /api/v2/admin/users (Hono)', () => {
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

  describe('POST /api/v2/admin/users/invite', () => {
    let adminToken: string;
    let userToken: string;

    beforeEach(async () => {
      await clearUsers();

      const admin = await createTestUser({
        name: 'Invite Admin',
        username: 'inviteAdmin',
        email: 'invite-admin@example.com',
        admin: true,
      });
      adminToken = admin.accessToken;

      const normal = await createTestUser({
        name: 'Invite Normal',
        username: 'inviteNormal',
        email: 'invite-normal@example.com',
        admin: false,
      });
      userToken = normal.accessToken;
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v2/admin/users/invite')
        .send({ emailList: ['x@example.com'] });
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app)
        .post('/api/v2/admin/users/invite')
        .set(authHeaders(userToken))
        .send({ emailList: ['x@example.com'] });
      expect(res.status).toBe(403);
    });

    it('returns 400 when emailList is empty', async () => {
      const res = await request(app).post('/api/v2/admin/users/invite').set(authHeaders(adminToken)).send({ emailList: [] });
      expect(res.status).toBe(400);
    });

    it('creates new users and reports per-email status', async () => {
      const res = await request(app)
        .post('/api/v2/admin/users/invite')
        .set(authHeaders(adminToken))
        .send({ emailList: ['newcomer1@example.com', 'newcomer2@example.com'], sendEmail: false });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      const byEmail = new Map<string, { status: string; userId?: string }>(
        (res.body.results as Array<{ email: string; status: string; userId?: string }>).map((r) => [r.email, r]),
      );
      expect(byEmail.get('newcomer1@example.com')?.status).toBe('created');
      expect(byEmail.get('newcomer2@example.com')?.status).toBe('created');
      expect(byEmail.get('newcomer1@example.com')?.userId).toMatch(/^[0-9a-f]{24}$/);
    });

    it('reports already-existing emails as status="exists"', async () => {
      // Pre-create one user; the invite should report it as 'exists' rather than failing.
      await createPlainUser({ name: 'Existing', username: 'existing', email: 'duplicate@example.com' });

      const res = await request(app)
        .post('/api/v2/admin/users/invite')
        .set(authHeaders(adminToken))
        .send({ emailList: ['duplicate@example.com', 'fresh@example.com'] });

      expect(res.status).toBe(200);
      const byEmail = new Map<string, { status: string }>((res.body.results as Array<{ email: string; status: string }>).map((r) => [r.email, r]));
      expect(byEmail.get('duplicate@example.com')?.status).toBe('exists');
      expect(byEmail.get('fresh@example.com')?.status).toBe('created');
    });
  });

  describe('per-user mutating endpoints', () => {
    let adminToken: string;
    let userToken: string;
    let target: UserDocument;

    beforeEach(async () => {
      await clearUsers();

      const admin = await createTestUser({
        name: 'Mut Admin',
        username: 'mutAdmin',
        email: 'mut-admin@example.com',
        admin: true,
      });
      adminToken = admin.accessToken;

      const normal = await createTestUser({
        name: 'Mut Normal',
        username: 'mutNormal',
        email: 'mut-normal@example.com',
        admin: false,
      });
      userToken = normal.accessToken;

      target = await createPlainUser({ name: 'Target', username: 'target', email: 'target@example.com' });
    });

    describe('PATCH /api/v2/admin/users/:id', () => {
      it('returns 401 without auth', async () => {
        const res = await request(app).patch(`/api/v2/admin/users/${target._id}`).send({ name: 'New', email: 'new@example.com' });
        expect(res.status).toBe(401);
      });

      it('returns 403 for a non-admin user', async () => {
        const res = await request(app).patch(`/api/v2/admin/users/${target._id}`).set(authHeaders(userToken)).send({ name: 'New', email: 'new@example.com' });
        expect(res.status).toBe(403);
      });

      it('updates name and email', async () => {
        const res = await request(app)
          .patch(`/api/v2/admin/users/${target._id}`)
          .set(authHeaders(adminToken))
          .send({ name: 'Renamed', email: 'renamed@example.com' });

        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe('Renamed');
        expect(res.body.user.email).toBe('renamed@example.com');
        expect(res.body.user).not.toHaveProperty('password');
        expect(res.body.user).not.toHaveProperty('apiToken');
      });

      it('returns 404 for a non-existent id', async () => {
        // Random valid 24-char hex that does not match any user.
        const res = await request(app)
          .patch('/api/v2/admin/users/0123456789abcdef01234567')
          .set(authHeaders(adminToken))
          .send({ name: 'X', email: 'x@example.com' });
        expect(res.status).toBe(404);
      });

      it('returns 400 for an invalid id', async () => {
        const res = await request(app).patch('/api/v2/admin/users/not-a-valid-id').set(authHeaders(adminToken)).send({ name: 'X', email: 'x@example.com' });
        expect(res.status).toBe(400);
      });

      it('returns 409 when email collides with another user', async () => {
        const other = await createPlainUser({ name: 'Other', username: 'other', email: 'other@example.com' });
        const res = await request(app).patch(`/api/v2/admin/users/${target._id}`).set(authHeaders(adminToken)).send({ name: 'Target', email: other.email });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
      });

      it('allows setting the same email back to its own user', async () => {
        // Idempotent edit: name change without an email collision against itself.
        const res = await request(app)
          .patch(`/api/v2/admin/users/${target._id}`)
          .set(authHeaders(adminToken))
          .send({ name: 'Renamed Only', email: target.email });
        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe('Renamed Only');
      });
    });

    describe('PUT /api/v2/admin/users/:id/admin', () => {
      it('grants admin permission', async () => {
        const res = await request(app).put(`/api/v2/admin/users/${target._id}/admin`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.admin).toBe(true);
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app).put('/api/v2/admin/users/0123456789abcdef01234567/admin').set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(404);
      });

      it('returns 401 without auth', async () => {
        const res = await request(app).put(`/api/v2/admin/users/${target._id}/admin`).send({});
        expect(res.status).toBe(401);
      });
    });

    describe('DELETE /api/v2/admin/users/:id/admin', () => {
      it('revokes admin permission', async () => {
        // Make admin first so the demote actually flips the bit.
        target.admin = true;
        await target.save();

        const res = await request(app).delete(`/api/v2/admin/users/${target._id}/admin`).set(authHeaders(adminToken));
        expect(res.status).toBe(200);
        expect(res.body.user.admin).toBe(false);
      });

      it('returns 403 for a non-admin user', async () => {
        const res = await request(app).delete(`/api/v2/admin/users/${target._id}/admin`).set(authHeaders(userToken));
        expect(res.status).toBe(403);
      });
    });

    describe('PUT /api/v2/admin/users/:id/status/active', () => {
      it('activates a suspended user and emits the userEvent', async () => {
        const User = crowi.model('User');
        target.status = User.STATUS_SUSPENDED;
        await target.save();

        const userEvent = crowi.event('User');
        const onActivated = jest.fn();
        userEvent.on('activated', onActivated);

        const res = await request(app).put(`/api/v2/admin/users/${target._id}/status/active`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.status).toBe(User.STATUS_ACTIVE);
        expect(onActivated).toHaveBeenCalled();

        userEvent.off('activated', onActivated);
      });
    });

    describe('PUT /api/v2/admin/users/:id/status/suspended', () => {
      it('suspends an active user', async () => {
        const User = crowi.model('User');
        const res = await request(app).put(`/api/v2/admin/users/${target._id}/status/suspended`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.status).toBe(User.STATUS_SUSPENDED);
      });
    });

    describe('POST /api/v2/admin/users/:id/reset-password', () => {
      it('returns the new plaintext password and updated user', async () => {
        const res = await request(app).post(`/api/v2/admin/users/${target._id}/reset-password`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(typeof res.body.newPassword).toBe('string');
        expect(res.body.newPassword.length).toBeGreaterThan(0);
        expect(res.body.user._id).toBe(target._id.toString());
        expect(res.body.user).not.toHaveProperty('password');
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app).post('/api/v2/admin/users/0123456789abcdef01234567/reset-password').set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(404);
      });
    });

    describe('PUT /api/v2/admin/users/:id/email', () => {
      it('updates the email', async () => {
        const res = await request(app).put(`/api/v2/admin/users/${target._id}/email`).set(authHeaders(adminToken)).send({ email: 'updated@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe('updated@example.com');
      });

      it('returns 409 when the email collides with another user', async () => {
        const other = await createPlainUser({ name: 'Other2', username: 'other2', email: 'other2@example.com' });
        const res = await request(app).put(`/api/v2/admin/users/${target._id}/email`).set(authHeaders(adminToken)).send({ email: other.email });
        expect(res.status).toBe(409);
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app)
          .put('/api/v2/admin/users/0123456789abcdef01234567/email')
          .set(authHeaders(adminToken))
          .send({ email: 'whatever@example.com' });
        expect(res.status).toBe(404);
      });
    });
  });
});
