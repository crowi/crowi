import { Server } from 'node:http';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

/**
 * RFC-0004 Phase 5 — autocomplete endpoints
 * (`GET /api/users/autocomplete`, `GET /api/pages/autocomplete`).
 *
 * Covers: prefix > substring > fuzzy ranking, permission filtering
 * (other users' drafts and owner-granted pages excluded), and the
 * 60 req/min per-user rate limit (429 + `Retry-After`).
 */
describe('Routes /api/{users,pages}/autocomplete (Hono autocomplete)', () => {
  const PATH_PREFIX = '/hono-autocomplete-test/';
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;

  beforeAll(async () => {
    const [alice, bob] = await Promise.all([
      createTestUser({ name: 'Autocomplete Alpha', username: 'acAlphaUser', email: 'ac-alpha@example.com' }),
      createTestUser({ name: 'Autocomplete Beta', username: 'acBetaUser', email: 'ac-beta@example.com' }),
    ]);
    await createTestUser({ name: 'Autocomplete Alvin', username: 'acAlvinUser', email: 'ac-alvin@example.com' });
    aliceToken = alice.accessToken;
    aliceId = alice.user._id.toString();
    bobToken = bob.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
  });

  describe('GET /api/users/autocomplete', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/users/autocomplete').query({ q: 'ac' });
      expect(res.status).toBe(401);
    });

    it('returns username-prefix matches ranked above substring matches', async () => {
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'acAl' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      // acAlphaUser / acAlvinUser are username-prefix matches.
      expect(labels).toContain('acAlphaUser');
      expect(labels).toContain('acAlvinUser');
      // acBetaUser does not match `acAl` at all.
      expect(labels).not.toContain('acBetaUser');
      // scores are descending.
      const scores = res.body.results.map((r: { score: number }) => r.score);
      expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    });

    it('matches display name and email-local-part, not just username', async () => {
      // "Alpha" matches the display name "Autocomplete Alpha".
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'Alpha' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      expect(labels).toContain('acAlphaUser');
    });

    it('returns the username as label and a display string with @username', async () => {
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'acAlpha' });

      const hit = res.body.results.find((r: { label: string }) => r.label === 'acAlphaUser');
      expect(hit).toBeDefined();
      expect(hit.label).toBe('acAlphaUser');
      expect(hit.display).toBe('Autocomplete Alpha (@acAlphaUser)');
    });

    it('honours the limit parameter', async () => {
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'ac', limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
    });

    it('rejects an empty query with 400', async () => {
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/pages/autocomplete', () => {
    const createPage = async (token: string, suffix: string, grant = 1) => {
      const res = await request(app)
        .post('/api/pages')
        .set(authHeaders(token))
        .send({ path: `${PATH_PREFIX}${suffix}`, body: '# page', grant });
      expect(res.status).toBe(200);
      return res.body.page._id as string;
    };

    it('returns published pages matching the path', async () => {
      await createPage(aliceToken, 'spec-alpha');
      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'spec-alpha' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      expect(labels).toContain(`${PATH_PREFIX}spec-alpha`);
    });

    it('ranks a path-prefix match above a substring match', async () => {
      await createPage(aliceToken, 'query-leads');
      await createPage(aliceToken, 'nested/has-query-inside');
      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'has-query' });

      expect(res.status).toBe(200);
      // `has-query-inside` leaf is a prefix match; ranked first.
      expect(res.body.results[0].label).toBe(`${PATH_PREFIX}nested/has-query-inside`);
    });

    it("excludes another user's owner-granted page", async () => {
      // grant 4 = GRANT_OWNER — only bob can read it.
      await createPage(bobToken, 'bob-private', 4);
      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'bob-private' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      expect(labels).not.toContain(`${PATH_PREFIX}bob-private`);
    });

    it("excludes another user's draft page", async () => {
      // Create a draft owned by bob via the drafts endpoint.
      const draftRes = await request(app)
        .post('/api/pages/drafts')
        .set(authHeaders(bobToken))
        .send({ path: `${PATH_PREFIX}bob-draft` });
      expect(draftRes.status).toBe(201);

      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'bob-draft' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      expect(labels).not.toContain(`${PATH_PREFIX}bob-draft`);
    });

    it("includes the caller's own draft page", async () => {
      const draftRes = await request(app)
        .post('/api/pages/drafts')
        .set(authHeaders(aliceToken))
        .send({ path: `${PATH_PREFIX}alice-draft` });
      expect(draftRes.status).toBe(201);

      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'alice-draft' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      expect(labels).toContain(`${PATH_PREFIX}alice-draft`);
    });

    it('returns the full path as label and modifiedAt for the page', async () => {
      await createPage(aliceToken, 'with-meta');
      const res = await request(app).get('/api/pages/autocomplete').set(authHeaders(aliceToken)).query({ q: 'with-meta' });

      const hit = res.body.results.find((r: { label: string }) => r.label === `${PATH_PREFIX}with-meta`);
      expect(hit).toBeDefined();
      expect(hit.label).toBe(`${PATH_PREFIX}with-meta`);
      expect(typeof hit.modifiedAt).toBe('string');
    });

    it('anchor=prefix matches only paths that start with q (excludes mid-path substring hits)', async () => {
      // The "create page" modal queries with the full `/`-rooted prefix.
      await createPage(aliceToken, 'anchored-root');
      await createPage(aliceToken, 'nested/anchored-leaf');
      const res = await request(app)
        .get('/api/pages/autocomplete')
        .set(authHeaders(aliceToken))
        .query({ q: `${PATH_PREFIX}anchored`, anchor: 'prefix' });

      expect(res.status).toBe(200);
      const labels = res.body.results.map((r: { label: string }) => r.label);
      // Starts with the prefix → included.
      expect(labels).toContain(`${PATH_PREFIX}anchored-root`);
      // `anchored` only appears mid-path here → excluded under prefix anchoring.
      expect(labels).not.toContain(`${PATH_PREFIX}nested/anchored-leaf`);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After once the per-user budget is exceeded', async () => {
      // Budget is 60 req/min/user. A fresh user gets a clean window.
      const { accessToken } = await createTestUser({
        name: 'Rate Limited',
        username: 'acRateLimitedUser',
        email: 'ac-ratelimit@example.com',
      });

      // The limiter uses a fixed 60s window (`floor(now / windowMs)`).
      // Firing exactly 61 sequential requests is flaky: a slow CI run
      // can straddle a window boundary mid-burst, resetting the count
      // before it ever exceeds the budget. Fire 2*budget+1 requests
      // concurrently instead — the burst spans at most two windows, so
      // by pigeonhole one window receives >60 hits and returns 429,
      // wherever the boundary falls.
      //
      // Batching (size 50, not all 121 at once) is a SEPARATE concern from
      // `app` being a shared listening server (`src/test/setup.ts` —
      // feature-test-harness-shared-server): even against one shared
      // server, each `request(app)` call still opens its OWN TCP
      // connection (superagent doesn't pool/keep-alive), so firing all 121
      // fully concurrently would still open 121 simultaneous sockets
      // against that one server. The batch size bounds CONCURRENT sockets,
      // independent of whether there's one server or many — it stays even
      // though this test no longer stands up its own local `http.Server`
      // (via `createServer(...)` + `.listen(0)`) the way this file used to,
      // specifically to route around the per-request-listen behavior a
      // bare `RequestListener` triggers — see `app`'s doc comment in
      // `src/test/setup.ts` for why that workaround is no longer needed.
      const TOTAL_REQUESTS = 121;
      const BATCH_SIZE = 50;
      const fire = () => request(app).get('/api/users/autocomplete').set(authHeaders(accessToken)).query({ q: 'ac' });
      const responses: Awaited<ReturnType<typeof fire>>[] = [];
      for (let i = 0; i < TOTAL_REQUESTS; i += BATCH_SIZE) {
        const batchSize = Math.min(BATCH_SIZE, TOTAL_REQUESTS - i);
        const batch = await Promise.all(Array.from({ length: batchSize }, fire));
        responses.push(...batch);
      }
      expect(responses.every((res) => res.status === 200 || res.status === 429)).toBe(true);

      const limited = responses.find((res) => res.status === 429);
      expect(limited).toBeDefined();
      expect(limited?.body.error).toBe('rate_limited');
      expect(typeof limited?.body.retryAfterSeconds).toBe('number');
      expect(limited?.headers['retry-after']).toBeDefined();
    }, 15_000);

    it('counts the budget per-user (a second user is unaffected)', async () => {
      // aliceId is referenced to keep the per-user nature explicit.
      expect(typeof aliceId).toBe('string');
      const res = await request(app).get('/api/users/autocomplete').set(authHeaders(bobToken)).query({ q: 'ac' });
      expect(res.status).toBe(200);
    });
  });

  describe('shared listening server (feature-test-harness-shared-server)', () => {
    it('never calls Server.prototype.listen for a request — src/test/setup.ts already listens once in beforeAll', async () => {
      const listenSpy = jest.spyOn(Server.prototype, 'listen');

      try {
        const first = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'ac' });
        const second = await request(app).get('/api/users/autocomplete').set(authHeaders(aliceToken)).query({ q: 'ac' });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // Deterministic proof this fix is actually in effect (crowi-fix
        // discipline — written and run BEFORE the fix too, see the spec's
        // "検証設計" section, to prove the assertion itself is load-bearing):
        // when `src/test/setup.ts` exported `app` as a bare RequestListener,
        // supertest's `Test#serverAddress()` wrapped it in its own
        // `http.Server` and called `.listen(0)` once per `request(app)` call
        // (no shared listening Server to reuse) — 2 calls were observed for
        // the 2 requests above pre-fix (see the `feature-test-harness-shared-server`
        // commit message for the pre-fix/post-fix observation record). Now that
        // `setup.ts` exports `app` as an already-listening `http.Server`
        // (`beforeAll` awaits `listen(0, '127.0.0.1')` once for the whole
        // file), supertest's `app.address()` check short-circuits and
        // `.listen()` is never called again for a request — 0 calls here.
        expect(listenSpy).not.toHaveBeenCalled();
      } finally {
        // Restore even if a request/assertion above throws, so a failure in
        // this test can never leave the spy installed for later tests in
        // this file (they share the module-level `Server.prototype`).
        listenSpy.mockRestore();
      }
    });
  });
});
