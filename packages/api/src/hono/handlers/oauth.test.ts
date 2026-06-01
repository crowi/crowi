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
  const Device = () => crowi.model('OAuthDeviceCode');

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
    await Device().deleteMany({ clientId: 'crowi-cli' });
  });

  beforeEach(async () => {
    await Code().deleteMany({ userId: user._id });
    await Refresh().deleteMany({ userId: user._id });
    await PAT().deleteMany({ userId: user._id });
    await Device().deleteMany({ clientId: 'crowi-cli' });
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

  const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

  describe('Device Authorization Grant (RFC 8628)', () => {
    const deviceAuthorize = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/device/authorize').send(body);
    const token = (body: Record<string, unknown>) => request(app).post('/api/v2/oauth/token').send(body);
    const deviceVerify = (body: Record<string, unknown>, bearer = webToken) =>
      request(app).post('/api/v2/oauth/device/verify').set('Authorization', `Bearer ${bearer}`).send(body);

    const startDevice = async (scope = 'pages:read pages:write') => {
      const res = await deviceAuthorize({ client_id: 'crowi-cli', scope });
      expect(res.status).toBe(200);
      return res.body as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };
    };

    it('issues a device_code + user_code with verification URIs', async () => {
      const body = await startDevice();
      expect(body.device_code).toEqual(expect.any(String));
      expect(body.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ]{4}-[0-9]{4}$/);
      expect(body.verification_uri).toContain('/oauth/device');
      expect(body.verification_uri_complete).toContain(`user_code=${encodeURIComponent(body.user_code)}`);
      expect(body.interval).toBe(5);
      expect(body.expires_in).toBeGreaterThan(0);
    });

    it('rejects a scope outside the client allowed set (400 invalid_scope)', async () => {
      const res = await deviceAuthorize({ client_id: 'crowi-cli', scope: 'admin:read' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_scope');
    });

    it('rejects an unknown client (400 invalid_client)', async () => {
      const res = await deviceAuthorize({ client_id: 'no-such', scope: 'pages:read' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });

    it('end-to-end: pending → authorization_pending, approve → tokens → scoped API works', async () => {
      const dev = await startDevice('profile:read');

      // Before approval the poll returns authorization_pending.
      const pending = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(pending.status).toBe(400);
      expect(pending.body.error).toBe('authorization_pending');

      // GET /oauth/device surfaces the requesting client + scopes.
      const info = await request(app).get('/api/v2/oauth/device').query({ user_code: dev.user_code });
      expect(info.status).toBe(200);
      expect(info.body.client_id).toBe('crowi-cli');
      expect(info.body.scopes).toEqual(['profile:read']);

      // Approve from the web session.
      const verify = await deviceVerify({ user_code: dev.user_code, action: 'approve' });
      expect(verify.status).toBe(200);
      expect(verify.body.status).toBe('approved');

      // Force lastPolledAt back so the next poll is not slow_down-throttled.
      await Device().updateOne({ userCode: dev.user_code }, { lastPolledAt: new Date(Date.now() - 10_000) });

      const issued = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(issued.status).toBe(200);
      expect(issued.body.token_type).toBe('Bearer');
      expect(issued.body.refresh_token.startsWith('crowi_rt_')).toBe(true);
      expect(issued.body.scope).toBe('profile:read');

      // The issued access token reaches a profile:read-scoped API.
      const api = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${issued.body.access_token}`);
      expect(api.status).toBe(200);

      // Single-use: a second exchange of the same (now consumed) device_code fails.
      const second = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(second.status).toBe(400);
    });

    it('returns slow_down when polled faster than the interval', async () => {
      const dev = await startDevice('pages:read');
      const first = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(first.body.error).toBe('authorization_pending');
      // Immediate re-poll (< interval) → slow_down.
      const second = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('slow_down');
    });

    it('returns access_denied after the user denies', async () => {
      const dev = await startDevice('pages:read');
      const verify = await deviceVerify({ user_code: dev.user_code, action: 'deny' });
      expect(verify.status).toBe(200);
      expect(verify.body.status).toBe('denied');

      const res = await token({ grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: 'crowi-cli' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('access_denied');
    });

    it('returns expired_token for an expired device_code', async () => {
      const { deviceCode, deviceCodeHash } = Device().generateDeviceCode();
      await Device().create({
        deviceCodeHash,
        userCode: 'ZZZZ-0000',
        clientId: 'crowi-cli',
        requestedScopes: ['pages:read'],
        status: 'approved',
        userId: user._id,
        grantedScopes: ['pages:read'],
        expiresAt: new Date(Date.now() - 1000),
        interval: 5,
      });
      const res = await token({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: 'crowi-cli' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('expired_token');
    });

    it('matches a normalized user_code (lower-case, no dash)', async () => {
      const dev = await startDevice('pages:read');
      const verify = await deviceVerify({ user_code: dev.user_code.replace('-', '').toLowerCase(), action: 'approve' });
      expect(verify.status).toBe(200);
      expect(verify.body.status).toBe('approved');
    });

    it('GET /oauth/device 404s for an unknown user_code', async () => {
      const res = await request(app).get('/api/v2/oauth/device').query({ user_code: 'ZZZZ-9999' });
      expect(res.status).toBe(404);
    });

    it('device/verify is web-session only — an OAuth bearer is rejected (403)', async () => {
      const dev = await startDevice('pages:read');
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user, scopes: ['pages:read'], clientId: 'crowi-cli' });
      const res = await deviceVerify({ user_code: dev.user_code, action: 'approve' }, oauthToken);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('device/verify requires authentication (401 without bearer)', async () => {
      const dev = await startDevice('pages:read');
      const res = await request(app).post('/api/v2/oauth/device/verify').send({ user_code: dev.user_code, action: 'approve' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('returns RFC 8414 discovery metadata (incl. device grant)', async () => {
      const res = await request(app).get('/api/v2/.well-known/oauth-authorization-server');
      expect(res.status).toBe(200);
      expect(res.body.issuer).toEqual(expect.any(String));
      expect(res.body.token_endpoint).toContain('/api/v2/oauth/token');
      expect(res.body.revocation_endpoint).toContain('/api/v2/oauth/revoke');
      expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(res.body.device_authorization_endpoint).toContain('/api/v2/oauth/device/authorize');
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token', DEVICE_GRANT]));
      expect(res.body.response_types_supported).toEqual(['code']);
      expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['pages:read', 'pages:write']));
      expect(res.body.scopes_supported).not.toContain('admin:read');
      expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
    });

    it('pins every URL to CLIENT_URL and ignores a forged Host header', async () => {
      // RFC-0010: the discovery / device URLs must come from the trusted
      // CLIENT_URL origin (crowi.getBaseUrl()), never the request Host. A
      // forged Host must not leak into issuer / endpoints, otherwise a client
      // could be steered to an attacker origin.
      const env = crowi.getEnv() as { CLIENT_URL?: string };
      const prev = env.CLIENT_URL;
      env.CLIENT_URL = 'https://wiki.example.com/';
      try {
        const res = await request(app)
          .get('/api/v2/.well-known/oauth-authorization-server')
          .set('Host', 'evil.example.com')
          .set('X-Forwarded-Host', 'evil.example.com')
          .set('X-Forwarded-Proto', 'https');
        expect(res.status).toBe(200);
        // Trailing slash trimmed; built from CLIENT_URL, not the Host header.
        expect(res.body.issuer).toBe('https://wiki.example.com');
        expect(res.body.authorization_endpoint).toBe('https://wiki.example.com/oauth/authorize');
        expect(res.body.token_endpoint).toBe('https://wiki.example.com/api/v2/oauth/token');
        expect(res.body.device_authorization_endpoint).toBe('https://wiki.example.com/api/v2/oauth/device/authorize');
        expect(JSON.stringify(res.body)).not.toContain('evil.example.com');
      } finally {
        env.CLIENT_URL = prev;
      }
    });
  });
});
