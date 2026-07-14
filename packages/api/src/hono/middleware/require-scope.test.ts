import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0010 Phase 1 — integration coverage for the scope-aware Bearer
 * auth + `requireScope` guard, exercised through real handlers:
 *
 *   - GET  /api/v2/me  → profile:read
 *   - PUT  /api/v2/me  → profile:write
 *
 * We assert that:
 *   - a web-session access token (no scope claim = all scopes) passes
 *     every route — i.e. the existing UI behaviour is unchanged;
 *   - an OAuth token narrowed to the matching scope passes;
 *   - an OAuth token narrowed to an unrelated scope is rejected with
 *     403 INSUFFICIENT_SCOPE + a `WWW-Authenticate` header;
 *   - the write→read implication holds (a `profile:write` token can GET).
 *
 * The actual `/oauth/token` issuing path lands in Phase 3; here we mint
 * tokens directly via the `signOauthAccessToken` helper.
 */

const seedActiveUser = async (info: { name: string; username: string; email: string; password: string }) => {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email: info.email }, { username: info.username }] });
  return new Promise<UserDocument>((resolve, reject) => {
    User.createUserByEmailAndPassword(info.name, info.username, info.email, info.password, 'en', async (err, user) => {
      if (err) return reject(err);
      user.status = User.STATUS_ACTIVE;
      await user.save();
      resolve(user);
    });
  });
};

describe('requireScope (Hono scope-aware auth)', () => {
  const EMAIL = 'scope-test@example.com';
  let user: UserDocument;
  let webToken: string;
  let jwtUtil: ReturnType<typeof createJwtUtil>;

  beforeAll(async () => {
    user = await seedActiveUser({ name: 'Scope Test', username: 'scope-test', email: EMAIL, password: 'Password!1' });
    jwtUtil = createJwtUtil(crowi);
    webToken = jwtUtil.generateTokens(user).accessToken;
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: EMAIL });
  });

  const oauthToken = (scopes: string[]) => jwtUtil.signOauthAccessToken({ user, scopes, clientId: 'crowi-cli' });

  describe('web-session token (all scopes)', () => {
    it('passes a profile:read route (GET /me)', async () => {
      const res = await request(app).get('/api/v2/me').set('Authorization', `Bearer ${webToken}`);
      expect(res.status).toBe(200);
    });

    it('passes a profile:write route (PUT /me)', async () => {
      const res = await request(app)
        .put('/api/v2/me')
        .set('Authorization', `Bearer ${webToken}`)
        .send({ userForm: { name: 'Scope Test', email: EMAIL, lang: 'en' } });
      // Reaches the handler (200), not the scope guard (403).
      expect(res.status).toBe(200);
    });
  });

  describe('OAuth token with sufficient scope', () => {
    it('profile:read passes GET /me', async () => {
      const res = await request(app)
        .get('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['profile:read'])}`);
      expect(res.status).toBe(200);
    });

    it('profile:write passes PUT /me', async () => {
      const res = await request(app)
        .put('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['profile:write'])}`)
        .send({ userForm: { name: 'Scope Test', email: EMAIL, lang: 'en' } });
      expect(res.status).toBe(200);
    });

    it('profile:write also passes GET /me (write implies read)', async () => {
      const res = await request(app)
        .get('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['profile:write'])}`);
      expect(res.status).toBe(200);
    });

    it('umbrella read passes GET /me', async () => {
      const res = await request(app)
        .get('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['read'])}`);
      expect(res.status).toBe(200);
    });
  });

  describe('OAuth token with insufficient scope', () => {
    it('rejects GET /me (profile:read) with only pages:read', async () => {
      const res = await request(app)
        .get('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['pages:read'])}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.details).toEqual({ requiredScope: 'profile:read' });
      expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    });

    it('rejects PUT /me (profile:write) with only profile:read', async () => {
      const res = await request(app)
        .put('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken(['profile:read'])}`)
        .send({ userForm: { name: 'Scope Test', email: EMAIL, lang: 'en' } });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.details).toEqual({ requiredScope: 'profile:write' });
      expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    });

    it('rejects with an empty scope set', async () => {
      const res = await request(app)
        .get('/api/v2/me')
        .set('Authorization', `Bearer ${oauthToken([])}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  describe('auth boundary still enforced', () => {
    it('401s without a token', async () => {
      const res = await request(app).get('/api/v2/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  // Regression: applyScope must attach the guard on Hono's routing path
  // (`/user/:username`), not the OpenAPI path (`/user/{username}`). If the
  // literal `{username}` path is used, the guard never matches a real request
  // and the scope check is silently skipped for every parameterized route
  // (GET /user/{username} → profile:read here). The non-parameterized /me
  // routes above cannot catch this because their two path forms are identical.
  describe('parameterized-path route (RFC-0010 scope guard must still run)', () => {
    it('rejects GET /user/:username with a token lacking profile:read', async () => {
      const res = await request(app)
        .get('/api/v2/user/scope-test')
        .set('Authorization', `Bearer ${oauthToken(['pages:read'])}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.details).toEqual({ requiredScope: 'profile:read' });
      expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    });

    it('passes GET /user/:username with profile:read (guard runs and allows)', async () => {
      const res = await request(app)
        .get('/api/v2/user/scope-test')
        .set('Authorization', `Bearer ${oauthToken(['profile:read'])}`);
      expect(res.status).toBe(200);
    });
  });
});
