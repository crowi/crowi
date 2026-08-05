import request from 'supertest';
import { app, crowi, INVALID_USERNAME_CASES } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 1 — integration tests for the migrated
 * `tokenAuth` resource.
 *
 * Five endpoints are covered; the focus is wire-format parity with the
 * ts-rest era and the new behaviour where `/auth/me` / `/auth/logout`
 * run behind the Hono `createJwtAuth` middleware (the bridge in
 * `routes/index.ts` forwards the `Authorization` header verbatim, so
 * the middleware sees the bearer token and `c.set('user', userDoc)`
 * before the handler).
 */

const seedActiveUser = async (info: { name: string; username: string; email: string; password: string }) => {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email: info.email }, { username: info.username }] });

  // `Fixture.generate('User', [...])` skips the password-hashing
  // pipeline, so we go through the model's official factory instead —
  // that way `populateSecrets()` + `isPasswordValid()` work as in
  // production.
  return new Promise<{ user: import('src/models/user').UserDocument; password: string }>((resolve, reject) => {
    User.createUserByEmailAndPassword(info.name, info.username, info.email, info.password, 'en', async (err, user) => {
      if (err) return reject(err);
      // createUserByEmailAndPassword sets status to STATUS_REGISTERED
      // by default; flip to ACTIVE so login succeeds without the
      // invite-email round-trip.
      user.status = User.STATUS_ACTIVE;
      await user.save();
      resolve({ user, password: info.password });
    });
  });
};

describe('Routes /api/auth (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    // Snapshot the shared crowi config BEFORE wiping it, so afterAll restores
    // the namespace to its as-discovered (installed) state rather than leaving
    // it empty for the next file (the cross-file seed-401 flake).
    configSnapshot = await snapshotCrowiConfig(crowi);
    // /auth/login and /auth/register short-circuit with 503
    // APPLICATION_NOT_INSTALLED until a crowi Config doc exists, so
    // seed the install marker before any auth-flow test runs.
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  describe('POST /auth/login', () => {
    const LOGIN_EMAIL = 'tokenauth-login@example.com';

    beforeAll(async () => {
      await seedActiveUser({ name: 'Login Tester', username: 'login-tester', email: LOGIN_EMAIL, password: 'Password!1' });
    });

    afterAll(async () => {
      await User().deleteMany({ email: LOGIN_EMAIL });
    });

    it('returns access + refresh tokens on valid credentials', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: LOGIN_EMAIL, password: 'Password!1' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: expect.any(Number),
        user: { email: LOGIN_EMAIL, username: 'login-tester', name: 'Login Tester' },
      });
      // The legacy controller did `admin: user.admin === true` — a
      // brand-new user must therefore see `admin: false`, not
      // `undefined`.
      expect(res.body.user.admin).toBe(false);
    });

    it('returns 401 INVALID_CREDENTIALS on wrong password', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: LOGIN_EMAIL, password: 'wrong-password!' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    });

    it('returns 401 INVALID_CREDENTIALS on unknown email', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'Password!1' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 400 VALIDATION_ERROR on malformed body (defaultHook envelope)', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/register', () => {
    const NEW_EMAIL = 'tokenauth-register@example.com';

    afterEach(async () => {
      await User().deleteMany({ $or: [{ email: NEW_EMAIL }, { username: 'register-tester' }] });
    });

    it('creates a registered (email-unconfirmed) user pending confirmation, without auto-login', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'register-tester', name: 'Register Tester', email: NEW_EMAIL, password: 'Password!1' });

      // No tokens: the account must confirm its email first.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'confirmation_required' });
      expect(res.body.accessToken).toBeUndefined();

      const created = await User().findOne({ email: NEW_EMAIL });
      expect(created?.status).toBe(User().STATUS_REGISTERED);
      expect(created?.emailConfirmedAt ?? null).toBeNull();
    });

    it('blocks login with EMAIL_NOT_CONFIRMED until the account is activated', async () => {
      await request(app).post('/api/auth/register').send({ username: 'register-tester', name: 'Register Tester', email: NEW_EMAIL, password: 'Password!1' });

      const res = await request(app).post('/api/auth/login').send({ email: NEW_EMAIL, password: 'Password!1' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('EMAIL_NOT_CONFIRMED');
    });

    it('returns 409 USER_EXISTS when the email is already taken', async () => {
      await seedActiveUser({ name: 'Duplicate', username: 'duplicate-user', email: NEW_EMAIL, password: 'Password!1' });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'a-different-username', name: 'Other', email: NEW_EMAIL, password: 'Password!1' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USER_EXISTS');
      await User().deleteMany({ username: 'duplicate-user' });
    });

    it('returns approval_required (no auto-login) under restricted registration', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationMode'];
      await Config().updateConfig('crowi', 'security:registrationMode', Config().SECURITY_REGISTRATION_MODE_RESTRICTED);
      await crowi.getConfigService().load();

      try {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ username: 'register-tester', name: 'Register Tester', email: NEW_EMAIL, password: 'Password!1' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'approval_required' });
        expect(res.body.accessToken).toBeUndefined();

        const created = await User().findOne({ email: NEW_EMAIL });
        expect(created?.status).toBe(User().STATUS_REGISTERED);
      } finally {
        if (prev !== undefined) {
          await Config().updateConfig('crowi', 'security:registrationMode', prev);
        } else {
          await Config().deleteOne({ ns: 'crowi', key: 'security:registrationMode' });
        }
        await crowi.getConfigService().load();
      }
    });

    it('returns 403 REGISTRATION_CLOSED when admin has restricted signups', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationMode'];

      await Config().updateConfig('crowi', 'security:registrationMode', Config().SECURITY_REGISTRATION_MODE_CLOSED);
      await crowi.getConfigService().load();

      try {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ username: 'closed-mode-user', name: 'Closed Mode', email: 'closed-mode@example.com', password: 'Password!1' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
      } finally {
        if (prev !== undefined) {
          await Config().updateConfig('crowi', 'security:registrationMode', prev);
        } else {
          await Config().deleteOne({ ns: 'crowi', key: 'security:registrationMode' });
        }
        await crowi.getConfigService().load();
      }
    });

    it('enforces the email whitelist in every non-closed mode (legacy parity)', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationWhiteList'];

      await Config().updateConfig('crowi', 'security:registrationWhiteList', ['allowed.example.com']);
      await crowi.getConfigService().load();

      try {
        // Open mode (default) + whitelist set: a non-matching address is rejected.
        const blocked = await request(app)
          .post('/api/auth/register')
          .send({ username: 'wl-blocked', name: 'WL Blocked', email: 'blocked@other.test', password: 'Password!1' });
        expect(blocked.status).toBe(403);
        expect(blocked.body.error.code).toBe('EMAIL_NOT_ALLOWED');

        // A matching address (subdomain of the whitelisted domain) registers.
        const allowed = await request(app)
          .post('/api/auth/register')
          .send({ username: 'wl-allowed', name: 'WL Allowed', email: 'ok@allowed.example.com', password: 'Password!1' });
        expect(allowed.status).toBe(200);

        // Regression: the legacy `new RegExp(entry + '$')` matched this
        // (ends with 'allowed.example.com') even though it is a different
        // domain. The hardened literal match must reject it.
        const overmatch = await request(app)
          .post('/api/auth/register')
          .send({ username: 'wl-overmatch', name: 'WL Overmatch', email: 'evil@notallowed.example.com', password: 'Password!1' });
        expect(overmatch.status).toBe(403);
        expect(overmatch.body.error.code).toBe('EMAIL_NOT_ALLOWED');

        // Case-insensitive whitelist match: an uppercased *domain* still
        // matches the whitelist. Use a distinct local part — email uniqueness
        // is case-insensitive (USER_UNIQUE_COLLATION), so a mere case variant
        // of `ok@allowed.example.com` would be rejected as USER_EXISTS (409)
        // rather than exercising the whitelist path.
        const mixedCase = await request(app)
          .post('/api/auth/register')
          .send({ username: 'wl-case', name: 'WL Case', email: 'Mixed@Allowed.Example.com', password: 'Password!1' });
        expect(mixedCase.status).toBe(200);
      } finally {
        await User().deleteMany({ username: { $in: ['wl-blocked', 'wl-allowed', 'wl-overmatch', 'wl-case'] } });
        if (prev !== undefined) {
          await Config().updateConfig('crowi', 'security:registrationWhiteList', prev);
        } else {
          await Config().deleteOne({ ns: 'crowi', key: 'security:registrationWhiteList' });
        }
        await crowi.getConfigService().load();
      }
    });

    // feature-username-validation-contract — the shared `UsernameSchema`
    // rejects a non-conforming username at the OpenAPIHono request
    // boundary (before the handler runs), and accepts the 1-char / 64-char
    // legal boundary.
    describe('username validation (feature-username-validation-contract)', () => {
      beforeAll(async () => {
        // Ensure the case-insensitive unique username index exists before the
        // mixed-case duplicate test below relies on it (mirrors
        // uniqueness-e11000.test.ts's precaution against a cold-DB race).
        await User().createIndexes();
      });

      it.each(INVALID_USERNAME_CASES)('rejects a username that is %s with 400 VALIDATION_ERROR before touching the DB', async (_label, username) => {
        const email = `tokenauth-register-bad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@example.com`;
        const res = await request(app).post('/api/auth/register').send({ username, name: 'Bad Username', email, password: 'Password!1' });

        expect(res.status).toBe(400);
        expect(res.body.error?.code).toBe('VALIDATION_ERROR');

        const created = await User().findOne({ email });
        expect(created).toBeNull();
      });

      it('accepts a 1-character username at the lower boundary', async () => {
        const email = 'tokenauth-register-min-username@example.com';
        await User().deleteMany({ $or: [{ email }, { username: 'a' }] });

        const res = await request(app).post('/api/auth/register').send({ username: 'a', name: 'Min Username', email, password: 'Password!1' });
        expect(res.status).toBe(200);

        const created = await User().findOne({ email });
        expect(created?.username).toBe('a');
        await User().deleteMany({ $or: [{ email }, { username: 'a' }] });
      });

      it('accepts a 64-character username at the upper boundary', async () => {
        const username = 'a'.repeat(64);
        const email = 'tokenauth-register-max-username@example.com';
        await User().deleteMany({ $or: [{ email }, { username }] });

        const res = await request(app).post('/api/auth/register').send({ username, name: 'Max Username', email, password: 'Password!1' });
        expect(res.status).toBe(200);

        const created = await User().findOne({ email });
        expect(created?.username).toBe(username);
        await User().deleteMany({ $or: [{ email }, { username }] });
      });

      it('stores a mixed-case username verbatim, and a case-only duplicate registration is rejected by the existing case-insensitive unique index', async () => {
        const originalEmail = 'tokenauth-register-mixedcase@example.com';
        const duplicateEmail = 'tokenauth-register-mixedcase-2@example.com';
        await User().deleteMany({ $or: [{ email: originalEmail }, { email: duplicateEmail }, { username: 'MixedCase' }, { username: 'mixedcase' }] });

        const first = await request(app)
          .post('/api/auth/register')
          .send({ username: 'MixedCase', name: 'Mixed Case', email: originalEmail, password: 'Password!1' });
        expect(first.status).toBe(200);

        const created = await User().findOne({ email: originalEmail });
        // Verbatim storage: no case-fold / trim / normalization on save.
        expect(created?.username).toBe('MixedCase');

        // A case-only variant of an already-taken username collides via the
        // existing USER_UNIQUE_COLLATION unique index (the pre-check
        // `findOne` is case-sensitive so this specific pairing slips past it
        // and is caught by the index itself — same mapping as
        // uniqueness-e11000.test.ts). Semantics unchanged: still a 409.
        const second = await request(app)
          .post('/api/auth/register')
          .send({ username: 'mixedcase', name: 'Mixed Case 2', email: duplicateEmail, password: 'Password!1' });
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('USERNAME_TAKEN');

        await User().deleteMany({ $or: [{ email: originalEmail }, { email: duplicateEmail }, { username: 'MixedCase' }, { username: 'mixedcase' }] });
      });
    });
  });

  describe('POST /auth/refresh', () => {
    const REFRESH_EMAIL = 'tokenauth-refresh@example.com';
    let refreshToken: string;

    beforeAll(async () => {
      const { user } = await seedActiveUser({ name: 'Refresh', username: 'refresh-tester', email: REFRESH_EMAIL, password: 'Password!1' });
      refreshToken = createJwtUtil(crowi).generateTokens(user).refreshToken;
    });

    afterAll(async () => {
      await User().deleteMany({ email: REFRESH_EMAIL });
    });

    it('exchanges a valid refresh token for fresh access + refresh tokens', async () => {
      const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: { email: REFRESH_EMAIL },
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED on a bogus refresh token', async () => {
      const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'not-a-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 VALIDATION_ERROR when the body omits refreshToken (zod required)', async () => {
      const res = await request(app).post('/api/auth/refresh').send({});
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /auth/me', () => {
    const ME_EMAIL = 'tokenauth-me@example.com';
    let accessToken: string;

    beforeAll(async () => {
      const { user } = await seedActiveUser({ name: 'Me Tester', username: 'me-tester', email: ME_EMAIL, password: 'Password!1' });
      accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
    });

    afterAll(async () => {
      await User().deleteMany({ email: ME_EMAIL });
    });

    it('returns the current user when authenticated', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        email: ME_EMAIL,
        username: 'me-tester',
        name: 'Me Tester',
        admin: false,
        status: expect.any(Number),
        createdAt: expect.any(String),
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with a malformed bearer token', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('POST /auth/logout', () => {
    const LOGOUT_EMAIL = 'tokenauth-logout@example.com';
    let accessToken: string;
    let refreshToken: string;

    beforeAll(async () => {
      const { user } = await seedActiveUser({ name: 'Logout', username: 'logout-tester', email: LOGOUT_EMAIL, password: 'Password!1' });
      const tokens = createJwtUtil(crowi).generateTokens(user);
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
    });

    afterAll(async () => {
      await User().deleteMany({ email: LOGOUT_EMAIL });
    });

    it('returns 200 with the canned ACK when authenticated', async () => {
      const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({ refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Logged out successfully' });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without an access token (middleware applies)', async () => {
      const res = await request(app).post('/api/auth/logout').send({ refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
