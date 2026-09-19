import Debug from 'debug';
import { DEFAULT_ARTIFACT_MAX_BYTES } from 'src/artifact/constants';
import { buildArtifactContentSecurityPolicy, extractArtifactDigestMarkers } from 'src/artifact/csp';
import { ARTIFACT_TOKEN_TTL_SECONDS, deriveArtifactTokenKey, mintArtifactToken, prepareArtifactDelivery, resolveArtifactTokenKey } from 'src/artifact/delivery';
import { ingestHtmlArtifact } from 'src/artifact/ingest';
import * as artifactPolicy from 'src/artifact/policy';
import { STATUS_DRAFT, STATUS_RENAMING } from 'src/models/page';
import { VALID_ARTIFACT_HTML, validArtifactHtml } from 'src/test/artifact-fixtures';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import { resolveSignedTokenSecret } from 'src/util/signed-token-factory';
import request from 'supertest';

describe('artifact-stream (the token-authenticated serve route and the JWT-authenticated download route)', () => {
  const PATH_PREFIX = '/hono-artifact-stream-test/';
  let Page;
  let Revision;
  let accessToken: string;
  let userId: string;
  let user;
  let otherAccessToken: string;
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    configSnapshot = await snapshotCrowiConfig(crowi);

    const [owner, other] = await Promise.all([
      createTestUser({ name: 'Artifact Stream Test', username: 'artifactStreamTester', email: 'artifact-stream-tester@example.com' }),
      createTestUser({ name: 'Artifact Stream Other', username: 'artifactStreamOther', email: 'artifact-stream-other@example.com' }),
    ]);
    accessToken = owner.accessToken;
    user = owner.user;
    userId = String(owner.user._id);
    otherAccessToken = other.accessToken;
  });

  afterAll(() => restoreCrowiConfig(crowi, configSnapshot));

  afterEach(async () => {
    await Promise.all([Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } }), Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } })]);
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  /** Mode A (separate-origin). */
  const enableArtifactDelivery = () => {
    jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: 'https://artifacts.test', crowiOrigin: 'http://localhost:13001' });
  };

  const ingestedBody = async (html: string): Promise<string> => {
    const result = await ingestHtmlArtifact(html, { source: 'stored-revision', allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES });
    if (!result.ok) throw new Error('fixture unexpectedly rejected by ingestHtmlArtifact');
    return Buffer.from(result.bytes).toString('utf8');
  };

  const createArtifactPage = async (path: string, body: string) => {
    const page = await Page.create({ path, creator: userId, lastUpdateUser: userId });
    const newRevision = await Revision.prepareRevision(page, body, user, { contentType: 'artifact' });
    return Page.pushRevision(page, newRevision, user);
  };

  const insufficientScopeHeaders = async () => {
    const scoped = await createTestUser({
      name: 'Artifact Stream Scope',
      username: `artifactStreamScope${Date.now()}`,
      email: `artifact-stream-scope-${Date.now()}@example.com`,
    });
    const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['attachments:read'], clientId: 'crowi-cli' });
    return authHeaders(oauthToken);
  };

  // Buffers the raw response bytes so the byte-exact comparisons below
  // (AC-DL-3) compare `Buffer`s rather than supertest's own UTF-8-decoded
  // `res.text` re-encoding of them.
  const bufferParser = (response: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
    response.on('error', (err) => callback(err, Buffer.alloc(0)));
  };

  /** Runs `run()` while capturing every `debug('crowi:hono:handlers:artifact-stream', ...)` call as one joined string. */
  const captureDebugLog = async <T>(run: () => Promise<T>): Promise<{ res: T; logged: string }> => {
    const previousNamespaces = Debug.disable();
    const originalLog = Debug.log;
    const calls: unknown[][] = [];
    Debug.log = (...args: unknown[]) => {
      calls.push(args);
    };
    Debug.enable('crowi:hono:handlers:artifact-stream');
    let res: T;
    try {
      res = await run();
    } finally {
      Debug.log = originalLog;
      Debug.enable(previousNamespaces);
    }
    const logged = calls.map((callArgs) => callArgs.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');
    return { res, logged };
  };

  describe('GET /api/artifact/:pageId/:revisionId (Hono)', () => {
    test('V-1: 404 "Not found." when the t query param is missing, and Revision.findRevision is never called', async () => {
      const findRevisionSpy = jest.spyOn(Revision, 'findRevision');
      const res = await request(app).get('/api/artifact/000000000000000000000000/000000000000000000000000');
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(findRevisionSpy).not.toHaveBeenCalled();
    });

    test('V-1: 404 for a malformed token value', async () => {
      const res = await request(app).get('/api/artifact/000000000000000000000000/000000000000000000000000?t=whatever');
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-1: 404 for a token signed with the wrong key', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v1-wrong-key`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const wrongKey = deriveArtifactTokenKey('a-completely-different-secret');
      const token = mintArtifactToken(wrongKey, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-1: 404 for an expired token', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v1-expired`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() - 1 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-1: 404 when the token was minted for a different page/revision pair', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v1-mismatch`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: '000000000000000000000000', r: '000000000000000000000000', u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-2: 404 when the revision does not exist', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v2`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const missingRevisionId = '000000000000000000000001';
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: missingRevisionId, u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${missingRevisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-3: 404 when the revision exists but is not an HTML artifact (Markdown)', async () => {
      await enableArtifactDelivery();
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}v3-markdown`, '# markdown');
      const pageId = page._id;
      const revisionId = (page as unknown as { revision: { _id: string } }).revision._id;
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId.toString(), u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-4: 404 when the revision belongs to a different page than the URL names', async () => {
      await enableArtifactDelivery();
      const pageA = await createArtifactPage(`${PATH_PREFIX}v4-a`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageB = await createArtifactPage(`${PATH_PREFIX}v4-b`, await ingestedBody(validArtifactHtml({ body: '<p>b</p>' })));
      const pageAId = pageA._id.toString();
      const pageBRevisionId = pageB.revision._id.toString();
      const key = resolveArtifactTokenKey();
      // Token payload matches the URL exactly (so token verification passes);
      // the mismatch is purely between the STORED revision.page and pageAId.
      const token = mintArtifactToken(key, { p: pageAId, r: pageBRevisionId, u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageAId}/${pageBRevisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-1: 404 when the URL path uses uppercase-hex pageId/revisionId against a token minted with the lowercase ids — the comparison is exact, not case-insensitive', async () => {
      // A legitimate URL is always built by the mint route from the exact
      // p/r values it just signed, so its path segments are byte-identical
      // to the token's payload — an uppercase-hex path only occurs from a
      // crafted request. verifyArtifactToken does a plain `!==` on both
      // fields, so this must fail before the Revision is ever read (V-1),
      // not fall through to a later 404.
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v1-uppercase-id`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });

      const findRevisionSpy = jest.spyOn(Revision, 'findRevision');
      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId.toUpperCase()}/${revisionId.toUpperCase()}?t=${token}`));
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
      expect(findRevisionSpy).not.toHaveBeenCalled();
      expect(logged).toContain('V-1');
    });

    test('V-6: 500 "Artifact could not be served." when the Revision lookup itself throws, logged as V-6 (not an undocumented 3rd classification) and without leaking the caught error', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}v6-lookup-throws`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });

      const findRevisionSpy = jest.spyOn(Revision, 'findRevision').mockRejectedValueOnce(new Error('simulated db failure, must not reach the log'));
      let res: request.Response;
      let logged: string;
      try {
        ({ res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`)));
      } finally {
        findRevisionSpy.mockRestore();
      }

      expect(res.status).toBe(500);
      expect(res.text).toBe('Artifact could not be served.');
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('V-6');
      expect(logged).not.toContain('simulated db failure');
    });

    test('V-5: 404 when delivery is disabled, even with a valid token', async () => {
      // No configured artifact origin and same-origin not enabled: the mode
      // resolves to 'disabled' even though a valid token can still be
      // minted — distinct from V-1's "no/invalid token" case.
      const page = await createArtifactPage(`${PATH_PREFIX}v5`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found.');
    });

    test('V-6: 500 "Artifact could not be served." when the stored bytes have no digest markers, without leaking body content in the response or the debug log', async () => {
      await enableArtifactDelivery();
      // Bypasses ingest entirely — a raw, un-normalized artifact body has no
      // digest markers for `extractArtifactDigestMarkers` to find.
      const rawBody = validArtifactHtml();
      const page = await createArtifactPage(`${PATH_PREFIX}v6`, rawBody);
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const [payloadPart] = token.split('.');

      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`));
      expect(res.status).toBe(500);
      expect(res.text).toBe('Artifact could not be served.');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.text).not.toContain('rebeccapurple');
      expect(res.text).not.toContain('console.log');
      // The log carries only pageId/revisionId/classification
      // (V-6), never the token, its payload segment, the secret, the stored
      // artifact body, or the `ArtifactPolicyError` code/message the
      // marker-extraction failure produced internally.
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('V-6');
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(payloadPart);
      expect(logged).not.toContain(resolveSignedTokenSecret());
      expect(logged).not.toContain(rawBody);
      expect(logged).not.toContain('rebeccapurple');
      expect(logged).not.toContain('console.log');
      expect(logged).not.toContain('MARKER_MISSING');
      expect(logged).not.toContain('digest marker');
    });

    test('V-6: 500 "Artifact could not be served." when CSP assembly fails (unresolved crowiOrigin) even though the markers are valid, without leaking CSP failure details in the debug log', async () => {
      // `artifactOrigin` set (deliveryMode stays 'separate-origin', so V-5's
      // `deliveryMode === 'disabled'` check does NOT catch this) but
      // `crowiOrigin` unresolved — `buildArtifactContentSecurityPolicy` has
      // its own, distinct `crowiOrigin === null` failure case, so a
      // valid-marker body can still fail at the CSP-assembly step rather
      // than the marker-extraction one the other V-6 test exercises.
      jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue({ artifactOrigin: 'https://artifacts.test', crowiOrigin: null });
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}v6-csp`, body);
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();

      const markers = extractArtifactDigestMarkers(body);
      if (!markers.ok) throw new Error('fixture unexpectedly has no digest markers');
      const snapshot = artifactPolicy.resolveArtifactPolicySnapshot(crowi);
      expect(snapshot.deliveryMode).not.toBe('disabled');
      const cspFailure = buildArtifactContentSecurityPolicy(markers.markers, snapshot);
      expect(cspFailure.ok).toBe(false);
      const cspFailureMessage = cspFailure.ok ? '' : cspFailure.message;
      const cspFailureCode = cspFailure.ok ? '' : cspFailure.code;

      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const [payloadPart] = token.split('.');

      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`));
      expect(res.status).toBe(500);
      expect(res.text).toBe('Artifact could not be served.');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('V-6');
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(payloadPart);
      expect(logged).not.toContain(resolveSignedTokenSecret());
      expect(logged).not.toContain(body);
      expect(logged).not.toContain(cspFailureMessage);
      expect(logged).not.toContain(cspFailureCode);
    });

    test('a request with a Host header other than the configured artifact origin still succeeds — arrival origin is never checked', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}host-agnostic`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const res = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`).set('Host', 'unrelated-host.example.com');
      expect(res.status).toBe(200);
    });

    test('AC-DL-3 / AC-DL-4: a URL minted by the mint route serves the exact stored bytes followed by the frame bridge, with the full response header set', async () => {
      await enableArtifactDelivery();
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}full-flow`, body);

      const mintRes = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
      expect(mintRes.status).toBe(200);
      const url = new URL(mintRes.body.url);

      const res = await request(app)
        .get(url.pathname + url.search)
        .buffer(true)
        .parse(bufferParser);
      expect(res.status).toBe(200);
      const expected = prepareArtifactDelivery(body, artifactPolicy.resolveArtifactPolicySnapshot(crowi));
      if (!expected.ok) throw new Error('fixture unexpectedly fails delivery preparation');
      // AC-DL-3 requires a byte-exact match, not merely equal decoded
      // strings — compare the raw response `Buffer` against the expected
      // bytes' own UTF-8 encoding.
      expect(Buffer.compare(res.body as Buffer, Buffer.from(expected.body, 'utf8'))).toBe(0);

      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(expected.body, 'utf8')));
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-frame-options']).toBeUndefined();
      // Global middleware adds exactly 1 occurrence — the route itself must not duplicate it.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe(expected.header);
    });

    test('AC-DL-7: the serve route success logs only pageId/revisionId/outcome — never the token, its payload segment, or the secret', async () => {
      await enableArtifactDelivery();
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}log-safety`, body);
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + 60_000 });
      const [payloadPart] = token.split('.');

      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`));
      expect(res.status).toBe(200);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(payloadPart);
      expect(logged).not.toContain(resolveSignedTokenSecret());
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('ok');
    });

    test('AC-DL-7: the serve route failure (V-1, expired token) logs only pageId/revisionId/classification — never the token or its payload segment', async () => {
      await enableArtifactDelivery();
      const page = await createArtifactPage(`${PATH_PREFIX}log-safety-fail`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() - 1 });
      const [payloadPart] = token.split('.');

      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`));
      expect(res.status).toBe(404);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(payloadPart);
      expect(logged).not.toContain(resolveSignedTokenSecret());
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('V-1');
    });
  });

  describe('GET /api/pages/:id/artifact-download (Hono)', () => {
    test('401 when unauthenticated', async () => {
      const res = await request(app).get('/api/pages/000000000000000000000000/artifact-download');
      expect(res.status).toBe(401);
    });

    test('403 INSUFFICIENT_SCOPE for a token lacking pages:read', async () => {
      const res = await request(app)
        .get('/api/pages/000000000000000000000000/artifact-download')
        .set(await insufficientScopeHeaders());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    test('404 for a nonexistent page', async () => {
      const res = await request(app).get('/api/pages/000000000000000000000000/artifact-download').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('404 for a page the caller is not granted', async () => {
      const page = await createPageViaApi(otherAccessToken, `${PATH_PREFIX}dl-private`, '# secret', 4 /* GRANT_OWNER */);
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('404 for a draft page owned by someone else', async () => {
      const other = await createTestUser({
        name: 'Artifact DL Draft Owner',
        username: `artifactDlDraft${Date.now()}`,
        email: `artifact-dl-draft-${Date.now()}@example.com`,
      });
      const draft = await Page.create({ path: `${PATH_PREFIX}dl-draft`, creator: other.user._id, lastUpdateUser: other.user._id, status: STATUS_DRAFT });
      const res = await request(app).get(`/api/pages/${draft._id}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('400 VALIDATION_ERROR for a malformed revision query', async () => {
      const page = await createArtifactPage(`${PATH_PREFIX}dl-bad-revision`, await ingestedBody(VALID_ARTIFACT_HTML));
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download?revision=not-a-valid-id`).set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('404 when the revision query names a revision belonging to a different page', async () => {
      const pageA = await createArtifactPage(`${PATH_PREFIX}dl-cross-a`, await ingestedBody(VALID_ARTIFACT_HTML));
      const pageB = await createArtifactPage(`${PATH_PREFIX}dl-cross-b`, await ingestedBody(validArtifactHtml({ body: '<p>b</p>' })));
      const res = await request(app).get(`/api/pages/${pageA._id}/artifact-download?revision=${pageB.revision._id.toString()}`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('404 for a pointerless (revision-less) Page when no revision query is given', async () => {
      const page = await Page.create({ path: `${PATH_PREFIX}dl-pointerless`, creator: userId, lastUpdateUser: userId });
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('404 for a Markdown page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}dl-markdown`, '# markdown');
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('200: downloads the current revision bytes with the correct Content-Disposition and no CSP, even when delivery is not configured', async () => {
      // Deliberately no `enableArtifactDelivery()` — the download route works
      // regardless of delivery configuration.
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}dl-success`, body);
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, Buffer.from(body, 'utf8'))).toBe(0);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(page.path.split('/').pop())}.html`);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    test('200: an explicit revision query downloads that historical revision, not the current one', async () => {
      const v1Body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}dl-revision-switch`, v1Body);
      const v1RevisionId = page.revision._id.toString();
      const v2Body = await ingestedBody(validArtifactHtml({ body: '<p>v2</p>' }));
      const v2Revision = await Revision.prepareRevision(page, v2Body, user, { contentType: 'artifact' });
      await Page.pushRevision(page, v2Revision, user);

      const res = await request(app)
        .get(`/api/pages/${page._id}/artifact-download?revision=${v1RevisionId}`)
        .set(authHeaders(accessToken))
        .buffer(true)
        .parse(bufferParser);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, Buffer.from(v1Body, 'utf8'))).toBe(0);
    });

    test('400 INVALID_PAGE_ID for an uppercase-hex page id — the route regex accepts it, but isValidObjectId inside loadGrantedPage does not', async () => {
      const page = await createArtifactPage(`${PATH_PREFIX}dl-uppercase-id`, await ingestedBody(VALID_ARTIFACT_HTML));
      const uppercaseId = page._id.toString().toUpperCase();

      const res = await request(app).get(`/api/pages/${uppercaseId}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    test('404 for a malformed page id (unmatched route — the :id{[0-9a-fA-F]{24}} constraint keeps it from ever reaching loadGrantedPage)', async () => {
      const res = await request(app).get('/api/pages/not-a-valid-id/artifact-download').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('404 for a transitional (renaming) page', async () => {
      const page = await createArtifactPage(`${PATH_PREFIX}dl-renaming`, await ingestedBody(VALID_ARTIFACT_HTML));
      await Page.updateOne({ _id: page._id }, { $set: { status: STATUS_RENAMING } });
      const res = await request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken));
      expect(res.status).toBe(404);
    });

    test('AC-DL-7: the download route success logs only pageId/revisionId/outcome — never leaks the query string', async () => {
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}dl-log-success`, body);
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();

      const { res, logged } = await captureDebugLog(() =>
        request(app).get(`/api/pages/${pageId}/artifact-download?revision=${revisionId}`).set(authHeaders(accessToken)),
      );
      expect(res.status).toBe(200);
      expect(logged).toContain(pageId);
      expect(logged).toContain(revisionId);
      expect(logged).toContain('ok');
      expect(logged).not.toContain(`revision=${revisionId}`);
    });

    test('AC-DL-7: the download route failure logs only pageId/classification — never the secret', async () => {
      const page = await createPageViaApi(otherAccessToken, `${PATH_PREFIX}dl-log-fail`, '# secret', 4 /* GRANT_OWNER */);

      const { res, logged } = await captureDebugLog(() => request(app).get(`/api/pages/${page._id}/artifact-download`).set(authHeaders(accessToken)));
      expect(res.status).toBe(404);
      expect(logged).toContain(String(page._id));
      expect(logged).toContain('not-granted');
      expect(logged).not.toContain(resolveSignedTokenSecret());
    });

    test('AC-DL-7: an invalid revision query is never logged verbatim, even though it fails validation', async () => {
      const page = await createArtifactPage(`${PATH_PREFIX}dl-log-invalid-revision`, await ingestedBody(VALID_ARTIFACT_HTML));
      const garbageRevision = 'not-a-valid-revision-id-garbage-marker';

      const { res, logged } = await captureDebugLog(() =>
        request(app).get(`/api/pages/${page._id}/artifact-download?revision=${garbageRevision}`).set(authHeaders(accessToken)),
      );
      expect(res.status).toBe(400);
      expect(logged).toContain(String(page._id));
      expect(logged).toContain('invalid-revision');
      expect(logged).not.toContain(garbageRevision);
    });
  });

  describe('AC-DL-8 — registration order and independent auth boundaries', () => {
    test('the download route is behind JWT auth (401 unauthenticated) while the serve route is reachable with no auth at all (200)', async () => {
      await enableArtifactDelivery();
      const body = await ingestedBody(VALID_ARTIFACT_HTML);
      const page = await createArtifactPage(`${PATH_PREFIX}order-proof`, body);
      const pageId = page._id.toString();
      const revisionId = page.revision._id.toString();
      const key = resolveArtifactTokenKey();
      const token = mintArtifactToken(key, { p: pageId, r: revisionId, u: userId, e: Date.now() + ARTIFACT_TOKEN_TTL_SECONDS * 1000 });

      const downloadRes = await request(app).get(`/api/pages/${pageId}/artifact-download`);
      expect(downloadRes.status).toBe(401);

      const serveRes = await request(app).get(`/api/artifact/${pageId}/${revisionId}?t=${token}`);
      expect(serveRes.status).toBe(200);
    });
  });
});
