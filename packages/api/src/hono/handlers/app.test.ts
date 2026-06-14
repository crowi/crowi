import request from 'supertest';
import { app, crowi } from 'src/test/setup';

/**
 * RFC-0006 Phase 3 — integration test for the migrated `app` resource.
 *
 * `GET /api/v2/app/info` is now served by Hono (see
 * `packages/api/src/hono/handlers/app.ts`). The wire format is
 * `{ title: string | null, confidential: string | null, version: string,
 * apiVersion: string, capabilities: string[] }` where `title` is `null`
 * when the operator has not customised it (the `'Crowi'` seed value counts
 * as "not customised") and `confidential` is `null` when the
 * confidentiality notice (`app:confidential`) is unset/empty. `version` /
 * `apiVersion` / `capabilities` are the version-skew / feature-detection
 * signal read by the `@crowi/cli` end-user CLI.
 */
describe('GET /api/v2/app/info (Hono)', () => {
  let Config: ReturnType<typeof crowi.model<'Config'>>;
  const APP_KEYS = ['app:title', 'app:confidential'];

  const reloadConfigCache = async () => {
    await crowi.getConfigService().load();
  };

  beforeAll(async () => {
    Config = crowi.model('Config');
  });

  afterEach(async () => {
    await Config.deleteMany({ ns: 'crowi', key: { $in: APP_KEYS } });
    await reloadConfigCache();
  });

  it('responds 200 without authentication (public route)', async () => {
    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns title=null when the seed default is in place', async () => {
    await Config.updateConfig('crowi', 'app:title', 'Crowi');
    await reloadConfigCache();

    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns title=null when no app:title row exists', async () => {
    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns the configured title when the operator has customised it', async () => {
    await Config.updateConfig('crowi', 'app:title', 'My Wiki');
    await reloadConfigCache();

    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'My Wiki', confidential: null });
  });

  it('returns confidential=null when the notice is empty', async () => {
    await Config.updateConfig('crowi', 'app:confidential', '');
    await reloadConfigCache();

    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: null });
  });

  it('returns the confidentiality notice when the operator has set it', async () => {
    await Config.updateConfig('crowi', 'app:confidential', 'For employees only');
    await reloadConfigCache();

    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: null, confidential: 'For employees only' });
  });

  it('reports the server version-skew / feature-detection signal', async () => {
    const res = await request(app).get('/api/v2/app/info');
    expect(res.status).toBe(200);

    // `version` is the running @crowi/api package version (a non-empty
    // string); `apiVersion` is the API surface version.
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(res.body.version).toBe(crowi.version);
    expect(res.body.apiVersion).toBe('v2');

    // `capabilities` is a non-empty list that always advertises the
    // statically-compiled subsystems the CLI relies on.
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    expect(res.body.capabilities).toEqual(expect.arrayContaining(['oauth', 'pages', 'comments', 'bookmarks', 'attachments', 'notifications']));
  });
});
