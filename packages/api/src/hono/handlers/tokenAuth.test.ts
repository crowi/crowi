import request from 'supertest';
import { app, crowi } from 'src/test/setup';
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

describe('Routes /api/v2/auth (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');

  beforeAll(async () => {
    // /auth/login and /auth/register short-circuit with 503
    // APPLICATION_NOT_INSTALLED until a crowi Config doc exists, so
    // seed the install marker before any auth-flow test runs.
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await Config().deleteMany({ ns: 'crowi' });
    await crowi.getConfigService().load();
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
      const res = await request(app).post('/api/v2/auth/login').send({ email: LOGIN_EMAIL, password: 'Password!1' });

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
      const res = await request(app).post('/api/v2/auth/login').send({ email: LOGIN_EMAIL, password: 'wrong-password!' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    });

    it('returns 401 INVALID_CREDENTIALS on unknown email', async () => {
      const res = await request(app).post('/api/v2/auth/login').send({ email: 'nobody@example.com', password: 'Password!1' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 400 VALIDATION_ERROR on malformed body (defaultHook envelope)', async () => {
      const res = await request(app).post('/api/v2/auth/login').send({ email: 'not-an-email', password: 'x' });
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
        .post('/api/v2/auth/register')
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
      await request(app).post('/api/v2/auth/register').send({ username: 'register-tester', name: 'Register Tester', email: NEW_EMAIL, password: 'Password!1' });

      const res = await request(app).post('/api/v2/auth/login').send({ email: NEW_EMAIL, password: 'Password!1' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('EMAIL_NOT_CONFIRMED');
    });

    it('returns 409 USER_EXISTS when the email is already taken', async () => {
      await seedActiveUser({ name: 'Duplicate', username: 'duplicate-user', email: NEW_EMAIL, password: 'Password!1' });

      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({ username: 'a-different-username', name: 'Other', email: NEW_EMAIL, password: 'Password!1' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USER_EXISTS');
      await User().deleteMany({ username: 'duplicate-user' });
    });

    it('returns 403 REGISTRATION_CLOSED when admin has restricted signups', async () => {
      const original = (await Config().loadAllConfig()) as { crowi: Record<string, unknown> };
      const prev = original.crowi['security:registrationMode'];

      await Config().updateConfig('crowi', 'security:registrationMode', Config().SECURITY_REGISTRATION_MODE_CLOSED);
      await crowi.getConfigService().load();

      try {
        const res = await request(app)
          .post('/api/v2/auth/register')
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
      const res = await request(app).post('/api/v2/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: { email: REFRESH_EMAIL },
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED on a bogus refresh token', async () => {
      const res = await request(app).post('/api/v2/auth/refresh').send({ refreshToken: 'not-a-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 VALIDATION_ERROR when the body omits refreshToken (zod required)', async () => {
      const res = await request(app).post('/api/v2/auth/refresh').send({});
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
      const res = await request(app).get('/api/v2/auth/me').set('Authorization', `Bearer ${accessToken}`);
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
      const res = await request(app).get('/api/v2/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with a malformed bearer token', async () => {
      const res = await request(app).get('/api/v2/auth/me').set('Authorization', 'Bearer not-a-jwt');
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
      const res = await request(app).post('/api/v2/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({ refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Logged out successfully' });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without an access token (middleware applies)', async () => {
      const res = await request(app).post('/api/v2/auth/logout').send({ refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
