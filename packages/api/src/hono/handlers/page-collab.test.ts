// Pin a stable WS_TOKEN_SECRET *before* `src/test/setup` boots the app —
// the handler captures the secret at app construction time, so setting
// this inside a `beforeAll` would be too late. With a fixed secret the
// HTTP-issued tokens and any locally-built `createWsTokenUtil()` share
// the same secret, suppressing the in-memory-fallback warning that
// otherwise polluted test output on every util instance.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import request from 'supertest';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import { createWsTokenUtil } from 'src/util/ws-token';
import { _setEditorCapCounterForTesting } from 'src/util/collab-cap';
import type { EditorCapCounter } from 'src/util/editor-cap-counter';

describe('Routes /api/v2/pages/:id/yjs-token (Hono getYjsToken)', () => {
  const PATH_PREFIX = '/hono-collab-token/';
  let accessToken: string;
  let userId: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const [owner, other] = await Promise.all([
      createTestUser({ name: 'Collab Token Tester', username: 'collabTokenTester', email: 'collab-token-tester@example.com' }),
      createTestUser({ name: 'Collab Token Other', username: 'collabTokenOther', email: 'collab-token-other@example.com' }),
    ]);
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();
    otherAccessToken = other.accessToken;
  });

  afterEach(async () => {
    // Phase 6: any test that injected a fake cap counter via
    // `_setEditorCapCounterForTesting` must clear it so the next
    // test sees the default (lazy Redis-backed) counter — and the
    // happy-path tests in particular default to no Redis ⇒ no-op
    // counter ⇒ readonly:false.
    _setEditorCapCounterForTesting(null);
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
  });

  /**
   * Build a fake editor-cap counter that simulates a cap-reached
   * page. Injected via `_setEditorCapCounterForTesting` for the
   * cap test below; the route handler reads through the cached
   * promise so the inject lands before the request is dispatched.
   */
  const makeCappedCounter = (count: number, cap: number): EditorCapCounter => ({
    maxEditorsPerPage: cap,
    async peek() {
      return { count, cap };
    },
    async tryAcquire() {
      return { acquired: count < cap, count, cap };
    },
    async release() {
      /* nothing */
    },
    async disconnect() {
      /* nothing */
    },
  });

  /**
   * Helper: create a page owned by the primary tester and return its
   * id. We go through the public `POST /pages` endpoint instead of
   * Page.create so the grant / revision wiring stays identical to how
   * end users would mint a target page.
   */
  const createPage = async (suffix: string, opts: { grant?: number } = {}) => {
    const path = `${PATH_PREFIX}${suffix}`;
    const res = await request(app)
      .post('/api/v2/pages')
      .set(authHeaders(accessToken))
      .send({ path, body: '# collab', ...(opts.grant ? { grant: opts.grant } : {}) });
    expect(res.status).toBe(200);
    return res.body.page._id as string;
  };

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/yjs-token').set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 400 INVALID_PAGE_ID when :id is not a 24-char hex string', async () => {
    const res = await request(app).get('/api/v2/pages/not-a-valid-id/yjs-token').set(authHeaders(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGE_ID');
  });

  it('returns 404 PAGE_NOT_FOUND for a well-formed but nonexistent page id', async () => {
    const res = await request(app).get('/api/v2/pages/000000000000000000000000/yjs-token').set(authHeaders(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns 404 PAGE_NOT_FOUND when the caller is not granted access (does not leak existence)', async () => {
    // grant: 4 = OWNER-only, so otherAccessToken cannot reach it.
    const pageId = await createPage('private', { grant: 4 });

    const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(otherAccessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  it('returns 200 with a signed wsToken, mirroring pageId / readonly=false / ISO expiresAt', async () => {
    const pageId = await createPage('basic');

    const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.pageId).toBe(pageId);
    // Phase 6 will wire the Redis-backed cap and start returning true at 21+ editors.
    // Until then the stub forces readonly=false for every caller.
    expect(res.body.readonly).toBe(false);
    expect(typeof res.body.wsToken).toBe('string');
    expect(res.body.wsToken.length).toBeGreaterThan(0);
    // expiresAt must round-trip through Date; the API contract is ISO 8601.
    const expiresAt = new Date(res.body.expiresAt);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
    // 5-minute TTL: allow generous slack for slow CI but assert the
    // shape (~now + 300s, never in the past, never absurdly far).
    const deltaSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(60);
    expect(deltaSeconds).toBeLessThanOrEqual(305);
    // editor-preview-reliability §1A: the response carries the page's
    // current revision id so the client can pin an edit base for the
    // collab save optimistic lock. A page created via POST /pages has a
    // revision, so this is a 24-hex id (never null here).
    expect(res.body.currentRevision).toMatch(/^[0-9a-f]{24}$/);
  });

  it('encodes the expected userId / pageId / readonly / issuer claims in the JWT payload', async () => {
    const pageId = await createPage('verify');

    const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(accessToken));
    expect(res.status).toBe(200);

    // Structural decode: we assert the JWT *payload* shape independently
    // of any verify call. A full sign↔verify round trip lives in the
    // util-level test below; both sides now share the same
    // `WS_TOKEN_SECRET` (pinned at the top of this file) so a future
    // tightening could route HTTP-issued tokens through `verifyWsToken`.
    const [, payloadB64] = (res.body.wsToken as string).split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(decoded.userId).toBe(userId);
    expect(decoded.pageId).toBe(pageId);
    expect(decoded.readonly).toBe(false);
    expect(decoded.iss).toBe('crowi-collab');
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
    expect(decoded.exp - decoded.iat).toBe(300);
  });

  it('returns 200 with readonly:true once the editor cap is reached (Phase 6 cap-driven readonly path)', async () => {
    // Inject a counter that reports 20-of-20 editors so `checkEditorCap`
    // flips to readonly:true. The wsToken still issues — readonly
    // clients live-subscribe but can't write.
    _setEditorCapCounterForTesting(makeCappedCounter(20, 20));
    const pageId = await createPage('cap-reached');

    const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.pageId).toBe(pageId);
    expect(res.body.readonly).toBe(true);
    expect(typeof res.body.wsToken).toBe('string');
    expect(res.body.wsToken.length).toBeGreaterThan(0);

    // The JWT payload must also carry readonly:true so the collab
    // process re-enforces it on `onAuthenticate` (defence-in-depth).
    const [, payloadB64] = (res.body.wsToken as string).split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(decoded.readonly).toBe(true);
  });

  // RFC-0004 Phase 2: a draft page may only mint a wsToken for its
  // author. The collab WebSocket carries this token, so refusing to
  // sign it for a non-author is the first of the two draft gates.
  describe('draft page access (RFC-0004)', () => {
    /** Create a page, then flip it to status='draft' directly. */
    const createDraftPage = async (suffix: string) => {
      const pageId = await createPage(suffix);
      const Page = crowi.model('Page');
      await Page.updateOne({ _id: pageId }, { $set: { status: 'draft' } });
      return pageId;
    };

    it('issues a wsToken to the draft author', async () => {
      const pageId = await createDraftPage('draft-owner');

      const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.pageId).toBe(pageId);
      expect(typeof res.body.wsToken).toBe('string');
    });

    it('returns 404 PAGE_NOT_FOUND for a non-author on a draft page (does not leak existence)', async () => {
      const pageId = await createDraftPage('draft-foreign');

      const res = await request(app).get(`/api/v2/pages/${pageId}/yjs-token`).set(authHeaders(otherAccessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });
  });

  it('signs and verifies a wsToken within a single ws-token util instance (sign↔verify round trip)', async () => {
    // This bypasses HTTP — it asserts the in-process invariant that
    // `verifyWsToken` accepts a token freshly produced by the same
    // helper, including the schema-level shape check on the decoded
    // payload. Both the Phase 2 handler and the Phase 3 Hocuspocus
    // `onAuthenticate` rely on this invariant holding for any given
    // process.
    const util = createWsTokenUtil();
    const { token } = util.signWsToken({ userId: 'user-1', pageId: 'page-1', readonly: true });
    const payload = util.verifyWsToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe('user-1');
    expect(payload?.pageId).toBe('page-1');
    expect(payload?.readonly).toBe(true);
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);
  });
});
