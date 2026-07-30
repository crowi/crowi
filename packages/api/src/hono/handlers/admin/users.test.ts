import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { authHeaders } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';
import type { UserDocument } from 'src/models/user';

interface CreateTestUserInput {
  name: string;
  username: string;
  email: string;
  admin?: boolean;
}

// Every user this file creates is tracked here so `clearUsers()` can wipe
// exactly this file's users between describe blocks — instead of a broad
// `User.deleteMany({})` that, when the test database is shared across suites
// under parallel jest workers, also deletes other blocks' JWT-backed seed
// users and makes their authenticated requests 401 on re-auth (the cross-block
// 401 flake). In the per-file-isolated DB the tracked set IS the whole table,
// so the pagination / count assertions below stay exact.
const ownedUserIds = new Set<string>();

const track = (user: UserDocument): UserDocument => {
  ownedUserIds.add(user._id.toString());
  return user;
};

// Seed users via Fixture, registering each id as owned by this file.
const seedUsers = async (infos: Array<Record<string, unknown>>): Promise<UserDocument[]> => {
  const users = (await Fixture.generate('User', infos)) as UserDocument[];
  users.forEach(track);
  return users;
};

// NOTE: This file intentionally defines its own createTestUser rather than
// importing from src/test/test-helpers. It uses the seedUsers+ownedUserIds
// tracking mechanism so that clearUsers() can delete exactly this file's
// users between describe blocks without touching other test files' users.
// This is required for the exact pagination / count assertions in this suite.
const createTestUser = async (info: CreateTestUserInput): Promise<{ user: UserDocument; accessToken: string }> => {
  const User = crowi.model('User');
  const [user] = await seedUsers([info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = !!info.admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

const createPlainUser = async (info: CreateTestUserInput): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = await seedUsers([info]);
  user.status = User.STATUS_ACTIVE;
  await user.save();
  return user;
};

const clearUsers = async () => {
  const User = crowi.model('User');
  // Wipe only this file's users (tracked above) so pagination math stays
  // predictable WITHOUT wiping seed users owned by other blocks/suites.
  await User.deleteMany({ _id: { $in: [...ownedUserIds] } });
  ownedUserIds.clear();
};

describe('Routes /api/admin/users (Hono)', () => {
  describe('GET /api/admin/users', () => {
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
      const res = await request(app).get('/api/admin/users');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/users').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the full user list for an admin', async () => {
      const res = await request(app).get('/api/admin/users').set(authHeaders(adminToken));

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

    it('keeps the AdminPager JSON shape stable after the mongoose-paginate-v2 migration', async () => {
      // mongoose-paginate-v2 renames the result envelope (total→totalDocs,
      // pages→totalPages). The handler absorbs that rename into createPager, so
      // the client-facing pager must still expose the legacy AdminPager keys
      // and must NOT leak the raw paginate-v2 field names.
      const res = await request(app).get('/api/admin/users').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.pager).sort()).toEqual(['next', 'nextDots', 'page', 'pages', 'pagesCount', 'previous', 'previousDots', 'total'].sort());
      expect(res.body.pager).not.toHaveProperty('totalDocs');
      expect(res.body.pager).not.toHaveProperty('totalPages');
      expect(res.body.pager).not.toHaveProperty('docs');
      expect(res.body.pager).not.toHaveProperty('hasNextPage');
    });

    it('omits sensitive fields (password / apiToken / googleId / githubId)', async () => {
      const res = await request(app).get('/api/admin/users').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      for (const u of res.body.users) {
        expect(u).not.toHaveProperty('password');
        expect(u).not.toHaveProperty('apiToken');
        expect(u).not.toHaveProperty('googleId');
        expect(u).not.toHaveProperty('githubId');
      }
    });

    it('filters by free-text query (q) on username/name/email', async () => {
      const res = await request(app).get('/api/admin/users').query({ q: 'alice' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.users[0].username).toBe('alice');
      expect(res.body.pager.total).toBe(1);
    });

    it("treats space in q as '|' for regex OR matching (legacy parity)", async () => {
      // 'alice bob' -> regex 'alice|bob' (only first space replaced) — both
      // alice@example.com and bob@sample.com should match.
      const res = await request(app).get('/api/admin/users').query({ q: 'alice bob' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      const usernames = (res.body.users as Array<{ username: string }>).map((u) => u.username).sort();
      expect(usernames).toEqual(['alice', 'bob']);
    });

    it('matches the email field, not just username/name', async () => {
      const res = await request(app).get('/api/admin/users').query({ q: 'sample.com' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBe(1);
      expect(res.body.users[0].email).toBe('bob@sample.com');
    });

    it('respects the page query parameter', async () => {
      // limit=2 → 5 users → 3 pages → page 2 has indices 2..3
      const res = await request(app).get('/api/admin/users').query({ page: 2, limit: 2 }).set(authHeaders(adminToken));

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
      const res = await request(app).get('/api/admin/users').query({ q: 'no-such-user-xyz' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.users).toEqual([]);
      expect(res.body.pager.total).toBe(0);
    });
  });

  describe('GET /api/admin/users/search', () => {
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
      const res = await request(app).get('/api/admin/users/search').query({ email: 'dave' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/users/search').query({ email: 'dave' }).set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when email param is missing', async () => {
      const res = await request(app).get('/api/admin/users/search').set(authHeaders(adminToken));
      expect(res.status).toBe(400);
    });

    it('returns email-substring matches for an admin', async () => {
      const res = await request(app).get('/api/admin/users/search').query({ email: 'example.com' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      const emails = (res.body.users as Array<{ email: string }>).map((u) => u.email).sort();
      // search-admin@example.com, search-normal@example.com, dave@example.com
      expect(emails).toEqual(['dave@example.com', 'search-admin@example.com', 'search-normal@example.com']);
    });

    it('omits sensitive fields in the search response', async () => {
      const res = await request(app).get('/api/admin/users/search').query({ email: 'dave' }).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      for (const u of res.body.users) {
        expect(u).not.toHaveProperty('password');
        expect(u).not.toHaveProperty('apiToken');
        expect(u).not.toHaveProperty('googleId');
        expect(u).not.toHaveProperty('githubId');
      }
    });
  });

  describe('POST /api/admin/users/invite', () => {
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
        .post('/api/admin/users/invite')
        .send({ emailList: ['x@example.com'] });
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app)
        .post('/api/admin/users/invite')
        .set(authHeaders(userToken))
        .send({ emailList: ['x@example.com'] });
      expect(res.status).toBe(403);
    });

    it('returns 400 when emailList is empty', async () => {
      const res = await request(app).post('/api/admin/users/invite').set(authHeaders(adminToken)).send({ emailList: [] });
      expect(res.status).toBe(400);
    });

    it('creates new users and reports per-email status', async () => {
      const res = await request(app)
        .post('/api/admin/users/invite')
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
        .post('/api/admin/users/invite')
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

    describe('PATCH /api/admin/users/:id', () => {
      it('returns 401 without auth', async () => {
        const res = await request(app).patch(`/api/admin/users/${target._id}`).send({ name: 'New', email: 'new@example.com' });
        expect(res.status).toBe(401);
      });

      it('returns 403 for a non-admin user', async () => {
        const res = await request(app).patch(`/api/admin/users/${target._id}`).set(authHeaders(userToken)).send({ name: 'New', email: 'new@example.com' });
        expect(res.status).toBe(403);
      });

      it('updates name and email', async () => {
        const res = await request(app)
          .patch(`/api/admin/users/${target._id}`)
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
          .patch('/api/admin/users/0123456789abcdef01234567')
          .set(authHeaders(adminToken))
          .send({ name: 'X', email: 'x@example.com' });
        expect(res.status).toBe(404);
      });

      it('returns 400 for an invalid id', async () => {
        const res = await request(app).patch('/api/admin/users/not-a-valid-id').set(authHeaders(adminToken)).send({ name: 'X', email: 'x@example.com' });
        expect(res.status).toBe(400);
      });

      it('returns 409 when email collides with another user', async () => {
        const other = await createPlainUser({ name: 'Other', username: 'other', email: 'other@example.com' });
        const res = await request(app).patch(`/api/admin/users/${target._id}`).set(authHeaders(adminToken)).send({ name: 'Target', email: other.email });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
      });

      it('allows setting the same email back to its own user', async () => {
        // Idempotent edit: name change without an email collision against itself.
        const res = await request(app).patch(`/api/admin/users/${target._id}`).set(authHeaders(adminToken)).send({ name: 'Renamed Only', email: target.email });
        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe('Renamed Only');
      });
    });

    describe('PUT /api/admin/users/:id/admin', () => {
      it('grants admin permission', async () => {
        const res = await request(app).put(`/api/admin/users/${target._id}/admin`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.admin).toBe(true);
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app).put('/api/admin/users/0123456789abcdef01234567/admin').set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(404);
      });

      it('returns 401 without auth', async () => {
        const res = await request(app).put(`/api/admin/users/${target._id}/admin`).send({});
        expect(res.status).toBe(401);
      });
    });

    describe('DELETE /api/admin/users/:id/admin', () => {
      it('revokes admin permission', async () => {
        // Make admin first so the demote actually flips the bit.
        target.admin = true;
        await target.save();

        const res = await request(app).delete(`/api/admin/users/${target._id}/admin`).set(authHeaders(adminToken));
        expect(res.status).toBe(200);
        expect(res.body.user.admin).toBe(false);
      });

      it('returns 403 for a non-admin user', async () => {
        const res = await request(app).delete(`/api/admin/users/${target._id}/admin`).set(authHeaders(userToken));
        expect(res.status).toBe(403);
      });
    });

    describe('PUT /api/admin/users/:id/status/active', () => {
      it('activates a suspended user and emits the userEvent', async () => {
        const User = crowi.model('User');
        target.status = User.STATUS_SUSPENDED;
        await target.save();

        const userEvent = crowi.event('User');
        const onActivated = jest.fn();
        userEvent.on('activated', onActivated);

        const res = await request(app).put(`/api/admin/users/${target._id}/status/active`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.status).toBe(User.STATUS_ACTIVE);
        expect(onActivated).toHaveBeenCalled();

        userEvent.off('activated', onActivated);
      });
    });

    describe('PUT /api/admin/users/:id/status/suspended', () => {
      it('suspends an active user', async () => {
        const User = crowi.model('User');
        const res = await request(app).put(`/api/admin/users/${target._id}/status/suspended`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(res.body.user.status).toBe(User.STATUS_SUSPENDED);
      });
    });

    describe('POST /api/admin/users/:id/reset-password', () => {
      it('returns the new plaintext password and updated user', async () => {
        const res = await request(app).post(`/api/admin/users/${target._id}/reset-password`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);
        expect(typeof res.body.newPassword).toBe('string');
        expect(res.body.newPassword.length).toBeGreaterThan(0);
        expect(res.body.user._id).toBe(target._id.toString());
        expect(res.body.user).not.toHaveProperty('password');
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app).post('/api/admin/users/0123456789abcdef01234567/reset-password').set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(404);
      });

      it("evicts the target's existing sessions", async () => {
        // An admin reset is the action taken *because* an account is
        // suspected compromised, so it has to strand whoever else is
        // holding a session — otherwise the admin hands the owner a new
        // password while the attacker keeps their access.
        const victimToken = createJwtUtil(crowi).generateTokens(target).accessToken;

        const before = await request(app).get('/api/me').set(authHeaders(victimToken));
        expect(before.status).toBe(200);

        const res = await request(app).post(`/api/admin/users/${target._id}/reset-password`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);

        const after = await request(app).get('/api/me').set(authHeaders(victimToken));
        expect(after.status).toBe(401);
      });

      it('invalidates password-reset links issued before the reset', async () => {
        // Same hole from the mail side: a reset link already in the
        // target's (possibly attacker-controlled) inbox must not survive
        // an admin reset. Asserted end-to-end against the real reset routes
        // rather than by watching the counter move — a counter assertion
        // would still pass if the reset verifier stopped consulting it, or
        // if the admin path bumped a field nothing checks.
        const User = crowi.model('User');
        const before = await User.findById(target._id);
        const staleLink = createMailTokenUtil().signMailToken({
          purpose: 'reset',
          userId: target._id.toString(),
          email: before.email,
          resetGeneration: before.passwordResetGeneration ?? 0,
        }).token;

        // The link is live right up until the admin resets.
        const validBefore = await request(app).get('/api/auth/reset-password').query({ token: staleLink });
        expect(validBefore.status).toBe(200);

        const res = await request(app).post(`/api/admin/users/${target._id}/reset-password`).set(authHeaders(adminToken)).send({});
        expect(res.status).toBe(200);

        const validAfter = await request(app).get('/api/auth/reset-password').query({ token: staleLink });
        expect(validAfter.status).toBe(401);
        expect(validAfter.body.error.code).toBe('INVALID_RESET_TOKEN');

        const consumed = await request(app)
          .post('/api/auth/reset-password')
          .set({ 'Content-Type': 'application/json' })
          .send({ token: staleLink, password: 'attacker-chosen-pw' });
        expect(consumed.status).toBe(401);

        // ...and the admin-issued password is what actually stands.
        const reloaded = await User.findById(target._id).select('+password');
        expect(reloaded?.isPasswordValid('attacker-chosen-pw')).toBe(false);
        expect(reloaded?.isPasswordValid(res.body.newPassword)).toBe(true);
      });
    });

    describe('PUT /api/admin/users/:id/email', () => {
      it('updates the email', async () => {
        const res = await request(app).put(`/api/admin/users/${target._id}/email`).set(authHeaders(adminToken)).send({ email: 'updated@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe('updated@example.com');
      });

      it('returns 409 when the email collides with another user', async () => {
        const other = await createPlainUser({ name: 'Other2', username: 'other2', email: 'other2@example.com' });
        const res = await request(app).put(`/api/admin/users/${target._id}/email`).set(authHeaders(adminToken)).send({ email: other.email });
        expect(res.status).toBe(409);
      });

      it('returns 404 for a non-existent id', async () => {
        const res = await request(app)
          .put('/api/admin/users/0123456789abcdef01234567/email')
          .set(authHeaders(adminToken))
          .send({ email: 'whatever@example.com' });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('POST /api/admin/users/:id/resend-invite', () => {
    let adminToken: string;
    let userToken: string;
    let invited: UserDocument;
    let sendSpy: jest.SpyInstance;

    beforeEach(async () => {
      await clearUsers();
      const User = crowi.model('User');
      adminToken = (await createTestUser({ name: 'RI Admin', username: 'riadmin', email: 'ri-admin@example.com', admin: true })).accessToken;
      userToken = (await createTestUser({ name: 'RI User', username: 'riuser', email: 'ri-user@example.com' })).accessToken;

      const [u] = await seedUsers([{ name: 'RI Invitee', username: 'riinvitee', email: 'ri-invitee@example.com' }]);
      u.status = User.STATUS_INVITED;
      await u.save();
      invited = u;

      // No mail sender is registered in tests, so getMailer().send() would
      // throw "Mail sender not registered". Spy on it so each test controls
      // whether the (single, memoized) mailer resolves or rejects.
      sendSpy = jest.spyOn(crowi.getMailer(), 'send').mockResolvedValue(undefined);
    });

    afterEach(() => {
      sendSpy.mockRestore();
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).post(`/api/admin/users/${invited._id}/resend-invite`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post(`/api/admin/users/${invited._id}/resend-invite`).set(authHeaders(userToken));
      expect(res.status).toBe(403);
    });

    it('re-issues an invite token and resends the invitation email', async () => {
      const res = await request(app).post(`/api/admin/users/${invited._id}/resend-invite`).set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.user._id).toBe(invited._id.toString());
      expect(res.body.user).not.toHaveProperty('password');
      // The invite email goes out via the shared mailer.send('invite') path
      // with a fresh token-bearing accept link.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const arg = sendSpy.mock.calls[0][0] as { to: string; htmlTemplate: string; vars: { inviteUrl: string } };
      expect(arg.htmlTemplate).toBe('invite');
      expect(arg.to).toBe(invited.email);
      expect(arg.vars.inviteUrl).toMatch(/\/invite\/accept\?token=/);
    });

    it('returns 409 when the user is not INVITED (already accepted / never invited)', async () => {
      const active = await createPlainUser({ name: 'RI Active', username: 'riactive', email: 'ri-active@example.com' });
      const res = await request(app).post(`/api/admin/users/${active._id}/resend-invite`).set(authHeaders(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request(app).post('/api/admin/users/0123456789abcdef01234567/resend-invite').set(authHeaders(adminToken));
      expect(res.status).toBe(404);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid id', async () => {
      const res = await request(app).post('/api/admin/users/not-a-valid-id/resend-invite').set(authHeaders(adminToken));
      expect(res.status).toBe(400);
    });

    it('returns 500 when the invitation email fails to send', async () => {
      sendSpy.mockRejectedValueOnce(new Error('smtp down'));
      const res = await request(app).post(`/api/admin/users/${invited._id}/resend-invite`).set(authHeaders(adminToken));
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/admin/users/pending-count', () => {
    let adminToken: string;

    beforeEach(async () => {
      await clearUsers();
      const User = crowi.model('User');
      adminToken = (await createTestUser({ name: 'PC Admin', username: 'pcadmin', email: 'pc-admin@example.com', admin: true })).accessToken;

      // Two REGISTERED (awaiting approval) + one ACTIVE that must not be counted.
      const [r1, r2] = await seedUsers([
        { name: 'Pending One', username: 'pending1', email: 'pending1@example.com' },
        { name: 'Pending Two', username: 'pending2', email: 'pending2@example.com' },
      ]);
      r1.status = User.STATUS_REGISTERED;
      r2.status = User.STATUS_REGISTERED;
      await r1.save();
      await r2.save();
    });

    it('returns 403 for a non-admin user', async () => {
      const userToken = (await createTestUser({ name: 'PC User', username: 'pcuser', email: 'pc-user@example.com' })).accessToken;
      const res = await request(app).get('/api/admin/users/pending-count').set(authHeaders(userToken));
      expect(res.status).toBe(403);
    });

    it('counts only REGISTERED (awaiting-approval) users', async () => {
      const res = await request(app).get('/api/admin/users/pending-count').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    let adminToken: string;
    let invited: UserDocument;

    beforeEach(async () => {
      await clearUsers();
      const User = crowi.model('User');
      adminToken = (await createTestUser({ name: 'Del Admin', username: 'deladmin', email: 'del-admin@example.com', admin: true })).accessToken;
      const [u] = await seedUsers([{ name: 'Invitee', username: 'invitee', email: 'invitee@example.com' }]);
      u.status = User.STATUS_INVITED;
      await u.save();
      invited = u;
    });

    it('physically removes an INVITED user', async () => {
      const res = await request(app).delete(`/api/admin/users/${invited._id}`).set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.deletedId).toBe(invited._id.toString());
      const stillThere = await crowi.model('User').findById(invited._id);
      expect(stillThere).toBeNull();
    });

    it('returns 409 when the user is not INVITED', async () => {
      const active = await createPlainUser({ name: 'Active U', username: 'activeu', email: 'active-u@example.com' });
      const res = await request(app).delete(`/api/admin/users/${active._id}`).set(authHeaders(adminToken));
      expect(res.status).toBe(409);
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request(app).delete('/api/admin/users/0123456789abcdef01234567').set(authHeaders(adminToken));
      expect(res.status).toBe(404);
    });
  });
});
