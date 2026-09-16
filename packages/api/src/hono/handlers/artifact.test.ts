import Debug from 'debug';
import { DEFAULT_ARTIFACT_MAX_BYTES } from 'src/artifact/constants';
import { resolveArtifactTokenKey, verifyArtifactToken } from 'src/artifact/delivery';
import { ingestHtmlArtifact } from 'src/artifact/ingest';
import * as artifactPolicy from 'src/artifact/policy';
import { STATUS_DRAFT, STATUS_RENAMING } from 'src/models/page';
import { validArtifactHtml } from 'src/test/artifact-fixtures';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

describe('POST /api/pages/:id/artifact-url (Hono)', () => {
  const PATH_PREFIX = '/hono-artifact-url-test/';
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
      createTestUser({ name: 'Artifact URL Test', username: 'artifactUrlTester', email: 'artifact-url-tester@example.com' }),
      createTestUser({ name: 'Artifact URL Other', username: 'artifactUrlOther', email: 'artifact-url-other@example.com' }),
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

  /** Mode A (separate-origin) — the "delivery is configured" baseline most tests need. */
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

  /** Runs `run()` while capturing every `debug('crowi:hono:handlers:artifact', ...)` call as one joined string. */
  const captureDebugLog = async <T>(run: () => Promise<T>): Promise<{ res: T; logged: string }> => {
    const previousNamespaces = Debug.disable();
    const originalLog = Debug.log;
    const calls: unknown[][] = [];
    Debug.log = (...args: unknown[]) => {
      calls.push(args);
    };
    Debug.enable('crowi:hono:handlers:artifact');
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

  const insufficientScopeHeaders = async () => {
    const scoped = await createTestUser({
      name: 'Artifact URL Scope',
      username: `artifactUrlScope${Date.now()}`,
      email: `artifact-url-scope-${Date.now()}@example.com`,
    });
    const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['attachments:read'], clientId: 'crowi-cli' });
    return authHeaders(oauthToken);
  };

  test('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/pages/000000000000000000000000/artifact-url').send({});
    expect(res.status).toBe(401);
  });

  test('403 INSUFFICIENT_SCOPE for a token lacking pages:read', async () => {
    // The scope guard runs BEFORE the page/revision lookup, so it rejects
    // even a nonexistent page id — no need to seed a page.
    const res = await request(app)
      .post('/api/pages/000000000000000000000000/artifact-url')
      .set(await insufficientScopeHeaders())
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  test('400 INVALID_PAGE_ID for a malformed page id', async () => {
    const res = await request(app).post('/api/pages/not-a-valid-id/artifact-url').set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGE_ID');
  });

  test('404 PAGE_NOT_FOUND for a nonexistent page id', async () => {
    const res = await request(app).post('/api/pages/000000000000000000000000/artifact-url').set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('404 PAGE_NOT_FOUND for a page the caller is not granted', async () => {
    const page = await createPageViaApi(otherAccessToken, `${PATH_PREFIX}private`, '# secret', 4 /* GRANT_OWNER */);
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('404 PAGE_NOT_FOUND for a draft page owned by someone else', async () => {
    const other = await createTestUser({
      name: 'Artifact URL Draft Owner',
      username: `artifactUrlDraft${Date.now()}`,
      email: `artifact-url-draft-${Date.now()}@example.com`,
    });
    const draft = await Page.create({ path: `${PATH_PREFIX}draft`, creator: other.user._id, lastUpdateUser: other.user._id, status: STATUS_DRAFT });
    const res = await request(app).post(`/api/pages/${draft._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('404 PAGE_NOT_FOUND for a transitional (renaming) page', async () => {
    const page = await createArtifactPage(`${PATH_PREFIX}renaming`, await ingestedBody(validArtifactHtml()));
    await Page.updateOne({ _id: page._id }, { $set: { status: STATUS_RENAMING } });
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('404 PAGE_NOT_FOUND when revisionId names a revision belonging to a different page', async () => {
    await enableArtifactDelivery();
    const pageA = await createArtifactPage(`${PATH_PREFIX}cross-a`, await ingestedBody(validArtifactHtml()));
    const pageB = await createArtifactPage(`${PATH_PREFIX}cross-b`, await ingestedBody(validArtifactHtml({ body: '<p>b</p>' })));
    const res = await request(app)
      .post(`/api/pages/${pageA._id}/artifact-url`)
      .set(authHeaders(accessToken))
      .send({ revisionId: pageB.revision._id.toString() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('404 PAGE_NOT_FOUND when revisionId names a revision that does not exist', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}missing-revision`, await ingestedBody(validArtifactHtml()));
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({ revisionId: '000000000000000000000000' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('400 VALIDATION_ERROR for a malformed revisionId', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}bad-revision-id`, await ingestedBody(validArtifactHtml()));
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({ revisionId: 'not-a-valid-id' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('404 PAGE_NOT_FOUND for a pointerless (revision-less) Page', async () => {
    const page = await Page.create({ path: `${PATH_PREFIX}pointerless`, creator: userId, lastUpdateUser: userId });
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
  });

  test('400 ARTIFACT_URL_UNAVAILABLE/NOT_AN_ARTIFACT for a Markdown page', async () => {
    await enableArtifactDelivery();
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}markdown`, '# markdown page');
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'ARTIFACT_URL_UNAVAILABLE', reason: 'NOT_AN_ARTIFACT' });
  });

  test('422 ARTIFACT_URL_UNAVAILABLE/ARTIFACT_DELIVERY_NOT_CONFIGURED when delivery is not configured (default baseline)', async () => {
    const page = await createArtifactPage(`${PATH_PREFIX}delivery-disabled`, await ingestedBody(validArtifactHtml()));
    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'ARTIFACT_URL_UNAVAILABLE', reason: 'ARTIFACT_DELIVERY_NOT_CONFIGURED' });
  });

  test('200: mints a URL for the current revision, expiring exactly 60s after mint, resolving the policy snapshot exactly once', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}success`, await ingestedBody(validArtifactHtml()));
    const snapshotSpy = jest.spyOn(artifactPolicy, 'resolveArtifactPolicySnapshot');

    const fixedNow = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    let res: request.Response;
    try {
      res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({});
    } finally {
      nowSpy.mockRestore();
    }

    expect(res.status).toBe(200);
    expect(res.body.url).toEqual(expect.stringContaining('https://artifacts.test/api/artifact/'));
    expect(res.body.expiresAt).toBe(new Date(fixedNow + 60_000).toISOString());
    expect(snapshotSpy).toHaveBeenCalledTimes(1);

    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/api/artifact/${page._id}/${page.revision._id.toString()}`);
    const token = url.searchParams.get('t');
    expect(token).not.toBeNull();

    const payload = verifyArtifactToken(
      resolveArtifactTokenKey(),
      token as string,
      { pageId: page._id.toString(), revisionId: page.revision._id.toString() },
      fixedNow,
    );
    expect(payload).not.toBeNull();
    expect(payload?.u).toBe(userId);
  });

  test('400 INVALID_PAGE_ID for an uppercase-hex page id, consistent with isValidObjectId everywhere else', async () => {
    // The route param has no shape constraint of its own, so an
    // uppercase-hex id reaches `loadGrantedPage`, whose `isValidObjectId`
    // is lowercase-only — same outcome as a non-hex-shaped id. Rejected
    // before delivery is even consulted, so no `enableArtifactDelivery()`.
    const page = await createArtifactPage(`${PATH_PREFIX}uppercase-id`, await ingestedBody(validArtifactHtml()));
    const uppercaseId = page._id.toString().toUpperCase();

    const res = await request(app).post(`/api/pages/${uppercaseId}/artifact-url`).set(authHeaders(accessToken)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGE_ID');
  });

  test('200: mints a URL for an explicit historical revisionId belonging to the same page', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}revision-switch`, await ingestedBody(validArtifactHtml()));
    const v1RevisionId = page.revision._id.toString();
    const v2Revision = await Revision.prepareRevision(page, await ingestedBody(validArtifactHtml({ body: '<p>v2</p>' })), user, { contentType: 'artifact' });
    await Page.pushRevision(page, v2Revision, user);

    const res = await request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({ revisionId: v1RevisionId });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/api/artifact/${page._id}/${v1RevisionId}`);
  });

  test('AC-DL-7: a successful mint logs only pageId/revisionId/outcome — never the token or its payload segment', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}log-success`, await ingestedBody(validArtifactHtml()));

    const { res, logged } = await captureDebugLog(() => request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({}));
    expect(res.status).toBe(200);
    const token = new URL(res.body.url).searchParams.get('t') as string;
    const [payloadPart] = token.split('.');

    expect(logged).toContain(String(page._id));
    expect(logged).toContain(page.revision._id.toString());
    expect(logged).toContain('ok');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(payloadPart);
  });

  test('AC-DL-7: a rejection (400 NOT_AN_ARTIFACT) logs only pageId/revisionId/a plain error outcome — never the specific reason', async () => {
    await enableArtifactDelivery();
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}log-reject`, '# markdown page');

    const { res, logged } = await captureDebugLog(() => request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({}));
    expect(res.status).toBe(400);
    expect(logged).toContain(String(page._id));
    expect(logged).toContain('error');
    expect(logged).not.toContain('NOT_AN_ARTIFACT');
  });

  test('AC-DL-7: an internal error (500) logs only pageId/outcome — never the caught error message', async () => {
    await enableArtifactDelivery();
    const page = await createArtifactPage(`${PATH_PREFIX}log-internal-error`, await ingestedBody(validArtifactHtml()));
    const findRevisionSpy = jest.spyOn(Revision, 'findRevision').mockRejectedValueOnce(new Error('simulated db failure, must not reach the log'));

    let res: request.Response;
    let logged: string;
    try {
      ({ res, logged } = await captureDebugLog(() =>
        request(app).post(`/api/pages/${page._id}/artifact-url`).set(authHeaders(accessToken)).send({ revisionId: page.revision._id.toString() }),
      ));
    } finally {
      findRevisionSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    expect(logged).toContain(String(page._id));
    expect(logged).toContain('error');
    expect(logged).not.toContain('simulated db failure');
  });
});
