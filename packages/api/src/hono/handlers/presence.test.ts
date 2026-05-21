// Pin a stable WS_TOKEN_SECRET *before* `src/test/setup` boots the app —
// the presence-token handler captures the secret at construction time,
// so a `beforeAll` set would be too late. A fixed secret lets the
// HTTP-issued token and any locally-built `createPresenceTokenUtil()`
// share one secret, suppressing the in-memory-fallback warning.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';
import { createPresenceTokenUtil } from 'src/util/presence-token';

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

describe('Routes /api/v2/pages/:id/presence-token (Hono getPresenceToken)', () => {
  const PATH_PREFIX = '/hono-presence-token/';
  let accessToken: string;
  let userId: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const [owner, other] = await Promise.all([
      createTestUser({ name: 'Presence Token Tester', username: 'presenceTokenTester', email: 'presence-token-tester@example.com' }),
      createTestUser({ name: 'Presence Token Other', username: 'presenceTokenOther', email: 'presence-token-other@example.com' }),
    ]);
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();
    otherAccessToken = other.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
  });

  /**
   * Create a page owned by the primary tester via the public
   * `POST /pages` endpoint so the grant / revision wiring stays
   * identical to how a real user would mint a target page.
   */
  const createPage = async (suffix: string, opts: { grant?: number } = {}) => {
    const path = `${PATH_PREFIX}${suffix}`;
    const res = await request(app)
      .post('/api/v2/pages')
      .set(authHeaders(accessToken))
      .send({ path, body: '# presence', ...(opts.grant ? { grant: opts.grant } : {}) });
    expect(res.status).toBe(200);
    return res.body.page._id as string;
  };

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/presence-token').set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 400 INVALID_PAGE_ID when :id is not a 24-char hex string', async () => {
    const res = await request(app).get('/api/v2/pages/not-a-valid-id/presence-token').set(authHeaders(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGE_ID');
  });

  it('returns 404 PAGE_NOT_FOUND for a well-formed but nonexistent page id', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/presence-token').set(authHeaders(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns 404 PAGE_NOT_FOUND when the caller lacks read permission (does not leak existence)', async () => {
    // grant: 4 = OWNER-only, so otherAccessToken cannot reach it.
    const pageId = await createPage('private', { grant: 4 });

    const res = await request(app).get(`/api/v2/pages/${pageId}/presence-token`).set(authHeaders(otherAccessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns 200 with a presence token, mirroring pageId / selfUserId / ISO expiresAt', async () => {
    const pageId = await createPage('basic');

    const res = await request(app).get(`/api/v2/pages/${pageId}/presence-token`).set(authHeaders(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.pageId).toBe(pageId);
    expect(res.body.selfUserId).toBe(userId);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);

    const expiresAt = new Date(res.body.expiresAt);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
    // 5-minute TTL: generous slack for slow CI but assert the shape.
    const deltaSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(60);
    expect(deltaSeconds).toBeLessThanOrEqual(305);
  });

  it('encodes userId / pageId / a presence-specific issuer in the JWT payload', async () => {
    const pageId = await createPage('verify');

    const res = await request(app).get(`/api/v2/pages/${pageId}/presence-token`).set(authHeaders(accessToken));
    expect(res.status).toBe(200);

    const [, payloadB64] = (res.body.token as string).split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(decoded.userId).toBe(userId);
    expect(decoded.pageId).toBe(pageId);
    // Distinct issuer from the collab wsToken ('crowi-collab') so the
    // two token kinds can never be cross-replayed.
    expect(decoded.iss).toBe('crowi-presence');
    expect(decoded.iss).not.toBe('crowi-collab');
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
    expect(decoded.exp - decoded.iat).toBe(300);
  });

  it('issues a token that the presence-token util verifies (sign ↔ verify round trip)', async () => {
    const pageId = await createPage('roundtrip');

    const res = await request(app).get(`/api/v2/pages/${pageId}/presence-token`).set(authHeaders(accessToken));
    expect(res.status).toBe(200);

    const util = createPresenceTokenUtil();
    const verified = util.verifyPresenceToken(res.body.token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe(userId);
    expect(verified?.pageId).toBe(pageId);
  });

  it('rejects a collab wsToken presented to the presence verifier (issuer isolation)', async () => {
    // A token minted for the collab channel must not verify as a
    // presence token — the issuers differ.
    const { createWsTokenUtil } = await import('src/util/ws-token');
    const wsToken = createWsTokenUtil().signWsToken({ userId: 'u', pageId: 'p', readonly: false }).token;
    const verified = createPresenceTokenUtil().verifyPresenceToken(wsToken);
    expect(verified).toBeNull();
  });
});
