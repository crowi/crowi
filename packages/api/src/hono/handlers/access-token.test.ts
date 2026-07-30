import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0010 Phase 2 — integration tests for PAT management
 * (`/me/access-tokens`) and the `createJwtAuth` PAT acceptance path.
 *
 * Covers (AC-aligned):
 *  - list returns metadata only (no `token` / `tokenHash`)
 *  - create returns the one-time plaintext, list afterwards still hides it
 *  - issuing an `admin:*` / unknown scope is a 400
 *  - delete revokes; a revoked PAT then 401s at the auth boundary
 *  - a `crowi_pat_` Bearer authenticates a real scoped route
 *  - scope shortfall on a PAT yields 403 INSUFFICIENT_SCOPE
 *  - an expired PAT 401s
 *  - PAT management is web-session only (PAT bearer → 403 FORBIDDEN)
 */

const seedActiveUser = async (info: { name: string; username: string; email: string; password: string }) => {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email: info.email }, { username: info.username }] });
  return new Promise<{ user: UserDocument; accessToken: string }>((resolve, reject) => {
    User.createUserByEmailAndPassword(info.name, info.username, info.email, info.password, 'en', async (err, user) => {
      if (err) return reject(err);
      user.status = User.STATUS_ACTIVE;
      await user.save();
      const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
      resolve({ user, accessToken });
    });
  });
};

describe('Routes /api/me/access-tokens (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  const PAT = () => crowi.model('PersonalAccessToken');

  const EMAIL = 'pat-owner@example.com';
  let user: UserDocument;
  let accessToken: string;
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    // Snapshot the shared crowi config before wiping it (afterAll restores it
    // to the as-discovered installed state rather than leaving it empty).
    configSnapshot = await snapshotCrowiConfig(crowi);
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();

    const seeded = await seedActiveUser({ name: 'PAT Owner', username: 'pat-owner', email: EMAIL, password: 'Password!1' });
    user = seeded.user;
    accessToken = seeded.accessToken;
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
    await User().deleteMany({ email: EMAIL });
    await PAT().deleteMany({ userId: user._id });
  });

  beforeEach(async () => {
    await PAT().deleteMany({ userId: user._id });
  });

  const web = (req: request.Test) => req.set('Authorization', `Bearer ${accessToken}`);

  describe('POST /me/access-tokens', () => {
    it('issues a PAT and returns the plaintext exactly once', async () => {
      const res = await web(request(app).post('/api/me/access-tokens')).send({ name: 'cli', scopes: ['pages:read'] });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('cli');
      expect(res.body.scopes).toEqual(['pages:read']);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.token.startsWith('crowi_pat_')).toBe(true);
      expect(res.body.expiresAt).toBeNull();

      // The list must not echo the secret back.
      const list = await web(request(app).get('/api/me/access-tokens'));
      expect(list.status).toBe(200);
      expect(list.body.accessTokens).toHaveLength(1);
      expect(list.body.accessTokens[0]).not.toHaveProperty('token');
      expect(list.body.accessTokens[0]).not.toHaveProperty('tokenHash');
    });

    it('rejects an admin:* scope with 400 INVALID_SCOPE', async () => {
      const res = await web(request(app).post('/api/me/access-tokens')).send({ name: 'bad', scopes: ['admin:read'] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SCOPE');
      expect(res.body.error.details.invalidScopes).toContain('admin:read');
    });

    it('rejects an unknown scope with 400 INVALID_SCOPE', async () => {
      const res = await web(request(app).post('/api/me/access-tokens')).send({ name: 'bad', scopes: ['pages:teleport'] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SCOPE');
    });

    it('accepts an umbrella scope', async () => {
      const res = await web(request(app).post('/api/me/access-tokens')).send({ name: 'umbrella', scopes: ['read'] });
      expect(res.status).toBe(201);
      expect(res.body.scopes).toEqual(['read']);
    });
  });

  describe('GET /me/access-tokens', () => {
    it('lists the current user tokens (metadata only)', async () => {
      await web(request(app).post('/api/me/access-tokens')).send({ name: 'a', scopes: ['pages:read'] });
      const res = await web(request(app).get('/api/me/access-tokens'));
      expect(res.status).toBe(200);
      expect(res.body.accessTokens).toHaveLength(1);
      expect(res.body.accessTokens[0].name).toBe('a');
    });
  });

  describe('DELETE /me/access-tokens/:id', () => {
    it('revokes a token and a revoked PAT then 401s', async () => {
      const created = await web(request(app).post('/api/me/access-tokens')).send({ name: 'revoke-me', scopes: ['profile:read'] });
      const plain = created.body.token as string;
      const id = created.body.id as string;

      // Works before revocation.
      const ok = await request(app).get('/api/me').set('Authorization', `Bearer ${plain}`);
      expect(ok.status).toBe(200);

      const del = await web(request(app).delete(`/api/me/access-tokens/${id}`));
      expect(del.status).toBe(200);

      // 401 after revocation.
      const after = await request(app).get('/api/me').set('Authorization', `Bearer ${plain}`);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 404 for an unknown token id', async () => {
      const res = await web(request(app).delete('/api/me/access-tokens/507f1f77bcf86cd799439011'));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('createJwtAuth PAT acceptance', () => {
    it('authenticates a scoped route with a crowi_pat_ Bearer', async () => {
      const created = await web(request(app).post('/api/me/access-tokens')).send({ name: 'reader', scopes: ['profile:read'] });
      const plain = created.body.token as string;

      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${plain}`);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(EMAIL);
    });

    it('returns 403 INSUFFICIENT_SCOPE when the PAT lacks the route scope', async () => {
      const created = await web(request(app).post('/api/me/access-tokens')).send({ name: 'readonly', scopes: ['profile:read'] });
      const plain = created.body.token as string;

      // PUT /me/password requires profile:write; a profile:read PAT is short.
      const res = await request(app)
        .put('/api/me/password')
        .set('Authorization', `Bearer ${plain}`)
        .send({ newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('401s an expired PAT', async () => {
      // Build the PAT directly so we can backdate its expiry.
      const PersonalAccessToken = PAT();
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({
        tokenHash,
        userId: user._id,
        name: 'expired',
        scopes: ['profile:read'],
        expiresAt: new Date(Date.now() - 1_000),
      });

      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  describe('web-session only guard (RFC-0010 §Security)', () => {
    it('rejects PAT management from a PAT bearer with 403 FORBIDDEN', async () => {
      const created = await web(request(app).post('/api/me/access-tokens')).send({ name: 'self', scopes: ['profile:read', 'profile:write'] });
      const plain = created.body.token as string;

      // List from the PAT itself -> forbidden.
      const list = await request(app).get('/api/me/access-tokens').set('Authorization', `Bearer ${plain}`);
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      // Create a new PAT from a PAT -> forbidden (no privilege escalation).
      const create = await request(app)
        .post('/api/me/access-tokens')
        .set('Authorization', `Bearer ${plain}`)
        .send({ name: 'nested', scopes: ['profile:read'] });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('auth boundary', () => {
    it('401s without a bearer token', async () => {
      const res = await request(app).get('/api/me/access-tokens');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
