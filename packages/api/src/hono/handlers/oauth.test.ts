import crypto from 'node:crypto';

import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0010 Phase 3 — OAuth authorization-server endpoint integration tests.
 *
 * Covers (AC-aligned):
 *  - authorize → token (authorization_code + PKCE) → scoped API access
 *  - PKCE S256 success / wrong-verifier failure
 *  - single-use authorization code (second exchange 400)
 *  - expired authorization code (400) — via direct model seed
 *  - refresh_token rotation + reuse detection (chain revocation)
 *  - redirect_uri: unregistered rejected, loopback any-port allowed
 *  - authorize is web-session only (PAT/oauth bearer → 403)
 *  - scope outside the client's allowed set rejected
 *  - revoke: refresh + PAT revoked (then 401 / invalid_grant), unknown → 200
 *  - discovery shape
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

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

describe('Routes /api/v2/oauth (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  const Code = () => crowi.model('OAuthAuthorizationCode');
  const Refresh = () => crowi.model('OAuthRefreshToken');
  const PAT = () => crowi.model('PersonalAccessToken');

  const EMAIL = 'oauth-user@example.com';
  const REDIRECT = 'http://127.0.0.1:51234/callback';
  let user: UserDocument;
  let webToken: string;

  beforeAll(async () => {
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
    const seeded = await seedActiveUser({ name: 'OAuth User', username: 'oauth-user', email: EMAIL, password: 'Password!1' });
    user = seeded.user;
    webToken = seeded.accessToken;
  });

  afterAll(async () => {
    await Config().deleteMany({ ns: 'crowi' });
    await crowi.getConfigService().load();
    await User().deleteMany({ email: EMAIL });
    await Code().deleteMany({ userId: user._id });
    await Refresh().deleteMany({ userId: user._id });
    await PAT().deleteMany({ userId: user._id });
  });

  beforeEach(async () => {
    await Code().deleteMany({ userId: user._id });
    await Refresh().deleteMany({ userId: user._id });
    await PAT().deleteMany({ userId: user._id });
  });

  const authorize = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/authorize').set('Authorization', `Bearer ${webToken}`).send(body);

  const authorizeOk = async (scope = 'pages:read pages:write') => {
    const { verifier, challenge } = pkce();
    const res = await authorize({
      client_id: 'crowi-cli',
      redirect_uri: REDIRECT,
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    expect(res.status).toBe(200);
    const url = new URL(res.body.redirectUri);
    const code = url.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('xyz');
    return { code: code as string, verifier };
  };

  describe('POST /oauth/authorize', () => {
    it('issues an authorization code with state echoed onto the redirect', async () => {
      await authorizeOk();
    });

    it('rejects an unregistered redirect_uri (400 invalid_request)', async () => {
      const { challenge } = pkce();
      const res = await authorize({
        client_id: 'crowi-cli',
        redirect_uri: 'https://evil.example/cb',
        scope: 'pages:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('allows any loopback port (registered loopback host)', async () => {
      const { challenge } = pkce();
      const res = await authorize({
        client_id: 'crowi-cli',
        redirect_uri: 'http://localhost:9999/done',
        scope: 'pages:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(200);
    });

    it('rejects a scope outside the client allowed set (400 invalid_scope)', async () => {
      const { challenge } = pkce();
      const res = await authorize({
        client_id: 'crowi-cli',
        redirect_uri: REDIRECT,
        scope: 'admin:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_scope');
    });

    it('rejects an unknown client (400 invalid_client)', async () => {
      const { challenge } = pkce();
      const res = await authorize({
        client_id: 'no-such-client',
        redirect_uri: REDIRECT,
        scope: 'pages:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });

    it('is web-session only — an OAuth bearer cannot mint codes (403)', async () => {
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user, scopes: ['pages:read'], clientId: 'crowi-cli' });
      const { challenge } = pkce();
      const res = await request(app).post('/api/v2/oauth/authorize').set('Authorization', `Bearer ${oauthToken}`).send({
        client_id: 'crowi-cli',
        redirect_uri: REDIRECT,
        scope: 'pages:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('requires authentication (401 without bearer)', async () => {
      const { challenge } = pkce();
      const res = await request(app).post('/api/v2/oauth/authorize').send({
        client_id: 'crowi-cli',
        redirect_uri: REDIRECT,
        scope: 'pages:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /oauth/token (authorization_code)', () => {
    const token = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/token').send(body);

    it('exchanges a code (+ correct verifier) for an access + refresh token', async () => {
      const { code, verifier } = await authorizeOk();
      const res = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: 'crowi-cli',
      });
      expect(res.status).toBe(200);
      expect(res.body.token_type).toBe('Bearer');
      expect(res.body.access_token).toEqual(expect.any(String));
      expect(res.body.refresh_token.startsWith('crowi_rt_')).toBe(true);
      expect(res.body.scope).toBe('pages:read pages:write');
      expect(res.body.expires_in).toBeGreaterThan(0);
    });

    it('accepts an application/x-www-form-urlencoded body', async () => {
      const { code, verifier } = await authorizeOk('pages:read');
      const res = await request(app)
        .post('/api/v2/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toEqual(expect.any(String));
    });

    it('lets the issued access token reach a scoped API (profile:read)', async () => {
      const { code, verifier } = await authorizeOk('profile:read');
      const tokenRes = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      const accessToken = tokenRes.body.access_token;
      // /me/recently-viewed-pages requires profile:read; the OAuth token holds it.
      const apiRes = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${accessToken}`);
      expect(apiRes.status).toBe(200);
      // A token lacking the scope is rejected with 403 INSUFFICIENT_SCOPE.
      const denied = await authorizeOk('pages:read');
      const deniedTokenRes = await token({
        grant_type: 'authorization_code',
        code: denied.code,
        code_verifier: denied.verifier,
        redirect_uri: REDIRECT,
        client_id: 'crowi-cli',
      });
      const deniedApi = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${deniedTokenRes.body.access_token}`);
      expect(deniedApi.status).toBe(403);
    });

    it('rejects a wrong PKCE verifier (400 invalid_grant)', async () => {
      const { code } = await authorizeOk();
      const res = await token({ grant_type: 'authorization_code', code, code_verifier: 'totally-wrong', redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a second exchange of the same code (single-use)', async () => {
      const { code, verifier } = await authorizeOk();
      const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(first.status).toBe(200);
      const second = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');
    });

    it('rejects an expired code (400 invalid_grant)', async () => {
      const { verifier, challenge } = pkce();
      const { code, codeHash } = Code().generateCode();
      await Code().create({
        codeHash,
        clientId: 'crowi-cli',
        userId: user._id,
        scopes: ['pages:read'],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        redirectUri: REDIRECT,
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a redirect_uri mismatch (400 invalid_grant)', async () => {
      const { code, verifier } = await authorizeOk();
      const res = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:1/other',
        client_id: 'crowi-cli',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });
  });

  describe('POST /oauth/token (refresh_token)', () => {
    const token = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/token').send(body);

    const getInitialPair = async () => {
      const { code, verifier } = await authorizeOk();
      const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      return res.body as { access_token: string; refresh_token: string };
    };

    it('rotates the refresh token and revokes the old one', async () => {
      const pair = await getInitialPair();
      const refreshed = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refresh_token).not.toBe(pair.refresh_token);

      // The old refresh token is now revoked — reusing it fails.
      const reuse = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(reuse.status).toBe(400);
      expect(reuse.body.error).toBe('invalid_grant');
    });

    it('detects reuse and revokes the whole chain', async () => {
      const pair = await getInitialPair();
      const r1 = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      const newRefresh = r1.body.refresh_token as string;

      // Replay the already-rotated original — reuse detection should fire
      // and revoke the successor too.
      const replay = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(replay.status).toBe(400);

      const successorNowDead = await token({ grant_type: 'refresh_token', refresh_token: newRefresh, client_id: 'crowi-cli' });
      expect(successorNowDead.status).toBe(400);
      expect(successorNowDead.body.error).toBe('invalid_grant');
    });

    it('rejects an unknown grant_type (400)', async () => {
      const res = await token({ grant_type: 'password', username: 'x', password: 'y' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /oauth/revoke', () => {
    const token = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/token').send(body);

    it('revokes a refresh token (then it cannot be used)', async () => {
      const { code, verifier } = await authorizeOk();
      const issued = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      const refresh = issued.body.refresh_token;

      const revoke = await request(app).post('/api/v2/oauth/revoke').send({ token: refresh });
      expect(revoke.status).toBe(200);

      const afterRevoke = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'crowi-cli' });
      expect(afterRevoke.status).toBe(400);
    });

    it('revokes a PAT (then it 401s at the auth boundary)', async () => {
      const { token: plain, tokenHash } = PAT().generateToken();
      await PAT().create({ tokenHash, userId: user._id, name: 'cli', scopes: ['profile:read'] });
      // PAT authenticates first.
      const before = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${plain}`);
      expect(before.status).toBe(200);

      const revoke = await request(app).post('/api/v2/oauth/revoke').send({ token: plain });
      expect(revoke.status).toBe(200);

      const after = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${plain}`);
      expect(after.status).toBe(401);
    });

    it('returns 200 for an unknown token (RFC 7009)', async () => {
      const res = await request(app).post('/api/v2/oauth/revoke').send({ token: 'crowi_rt_unknown' });
      expect(res.status).toBe(200);
      const noToken = await request(app).post('/api/v2/oauth/revoke').send({});
      expect(noToken.status).toBe(200);
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('returns RFC 8414 discovery metadata', async () => {
      const res = await request(app).get('/api/v2/.well-known/oauth-authorization-server');
      expect(res.status).toBe(200);
      expect(res.body.issuer).toEqual(expect.any(String));
      expect(res.body.token_endpoint).toContain('/api/v2/oauth/token');
      expect(res.body.revocation_endpoint).toContain('/api/v2/oauth/revoke');
      expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
      expect(res.body.response_types_supported).toEqual(['code']);
      expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['pages:read', 'pages:write']));
      expect(res.body.scopes_supported).not.toContain('admin:read');
      expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
    });
  });
});
