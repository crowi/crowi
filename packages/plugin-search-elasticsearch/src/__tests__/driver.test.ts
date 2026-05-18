import { applyConfig, applyConfigInPlace, createElasticsearchDriver, docToEsSource, parseUri, shouldIndex } from '../driver';
import type { ElasticsearchDriverConfig, PageStreamDoc } from '../driver';
import type { SearchableDoc } from '@crowi/plugin-api';

const CONFIG: ElasticsearchDriverConfig = { url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' };

describe('shouldIndex', () => {
  const base: PageStreamDoc = { _id: 'p1', path: '/foo', redirectTo: null, status: 'published', grant: 1 };

  it('indexes a published page', () => {
    expect(shouldIndex(base)).toBe(true);
  });

  it('excludes redirects, deleted pages and drafts', () => {
    expect(shouldIndex({ ...base, redirectTo: '/bar' })).toBe(false);
    expect(shouldIndex({ ...base, status: 'deleted' })).toBe(false);
    // Drafts have no per-viewer filter on the search route, so the rebuild
    // path must drop them just like the incremental indexing path does.
    expect(shouldIndex({ ...base, status: 'draft' })).toBe(false);
  });
});

describe('parseUri', () => {
  it('parses host + index name', () => {
    expect(parseUri('http://127.0.0.1:9200/crowi')).toEqual({
      node: 'http://127.0.0.1:9200',
      indexName: 'crowi',
    });
    expect(parseUri('https://user:pass@example.com:9200/myidx')).toEqual({
      node: 'https://user:pass@example.com:9200',
      indexName: 'myidx',
    });
  });

  it('defaults indexName when path is empty', () => {
    expect(parseUri('http://127.0.0.1:9200')).toEqual({ node: 'http://127.0.0.1:9200', indexName: 'crowi' });
    expect(parseUri('http://elasticsearch:9200/')).toEqual({ node: 'http://elasticsearch:9200', indexName: 'crowi' });
  });

  it('throws when scheme is missing', () => {
    expect(() => parseUri('elasticsearch:9200/')).toThrow(/should starts with http/);
  });
});

describe('docToEsSource', () => {
  it('expands meta fields into ES doc fields', () => {
    const doc: SearchableDoc = {
      id: 'abc',
      path: '/foo',
      body: 'hello',
      meta: {
        username: 'alice',
        grant: 4,
        granted_users: ['u1', 'u2'],
        comment_count: 3,
        bookmark_count: 7,
        like_count: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      },
    };
    expect(docToEsSource(doc)).toEqual({
      path: '/foo',
      body: 'hello',
      username: 'alice',
      grant: 4,
      granted_users: ['u1', 'u2'],
      comment_count: 3,
      bookmark_count: 7,
      like_count: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    });
  });

  it('also accepts camelCase metadata keys', () => {
    const doc: SearchableDoc = {
      id: 'abc',
      path: '/foo',
      body: 'hello',
      meta: { grantedUsers: ['x'], commentCount: 1, bookmarkCount: 2, likeCount: 3, createdAt: new Date('2026-03-04T05:06:07Z') },
    };
    const out = docToEsSource(doc);
    expect(out.granted_users).toEqual(['x']);
    expect(out.comment_count).toBe(1);
    expect(out.bookmark_count).toBe(2);
    expect(out.like_count).toBe(3);
    expect(out.created_at).toBeInstanceOf(Date);
  });

  it('omits absent / invalid fields rather than emitting nulls', () => {
    expect(docToEsSource({ id: 'a', path: '/p', body: 'b' })).toEqual({ path: '/p', body: 'b' });
  });
});

describe('createElasticsearchDriver query()', () => {
  const installFakeClient = (response: unknown) => {
    const driver = createElasticsearchDriver(applyConfig(CONFIG), { countUsers: async () => 5 });
    const fakeSearch = jest.fn().mockResolvedValue(response);
    (driver.client as unknown as { search: typeof fakeSearch }).search = fakeSearch;
    return { driver, fakeSearch };
  };

  it('translates ES9 hits into SearchHits + maps highlight to snippet', async () => {
    const { driver, fakeSearch } = installFakeClient({
      hits: {
        total: { value: 2 },
        hits: [
          { _id: 'p1', _score: 1.5, _source: { path: '/foo' }, highlight: { 'body.ja': ['<mark>hit</mark> body'] } },
          { _id: 'p2', _score: 0.8, _source: { path: '/bar' } },
        ],
      },
    });

    const result = await driver.query({ q: 'hit', viewer: { id: 'u', username: 'alice' } });
    expect(result.total).toBe(2);
    expect(result.hits).toEqual([
      { id: 'p1', path: '/foo', score: 1.5, snippet: '<mark>hit</mark> body' },
      { id: 'p2', path: '/bar', score: 0.8 },
    ]);

    expect(fakeSearch).toHaveBeenCalledTimes(1);
    const call = fakeSearch.mock.calls[0][0];
    expect(call.index).toBe('crowi-current');
    expect(call.from).toBe(0);
    expect(call.size).toBe(50);
    expect(JSON.stringify(call)).not.toContain('"_type"');
  });

  it('handles plain-number total (ES9 with track_total_hits=false)', async () => {
    const { driver } = installFakeClient({ hits: { total: 7, hits: [] } });
    const result = await driver.query({ q: 'x' });
    expect(result.total).toBe(7);
  });

  it('clamps oversized limit and computes from from page', async () => {
    const { driver, fakeSearch } = installFakeClient({ hits: { total: 0, hits: [] } });
    await driver.query({ q: 'x', page: 3, limit: 999 });
    const call = fakeSearch.mock.calls[0][0];
    expect(call.size).toBe(200);
    expect(call.from).toBe(2 * 200); // (page-1) * size
  });
});

describe('createElasticsearchDriver index/remove()', () => {
  it('index() sends a single ES9 index request (no _type, no bulk overhead)', async () => {
    const driver = createElasticsearchDriver(applyConfig(CONFIG));
    const fakeIndex = jest.fn().mockResolvedValue({ result: 'created' });
    (driver.client as unknown as { index: typeof fakeIndex }).index = fakeIndex;

    await driver.index({
      id: 'p1',
      path: '/p',
      body: 'b',
      meta: { username: 'alice', grant: 1 },
    });

    expect(fakeIndex).toHaveBeenCalledTimes(1);
    const call = fakeIndex.mock.calls[0][0];
    expect(call).toEqual({
      index: 'crowi-current',
      id: 'p1',
      document: { path: '/p', body: 'b', username: 'alice', grant: 1 },
    });
    expect(JSON.stringify(call)).not.toContain('"_type"');
  });

  it('remove() sends a single ES9 delete request', async () => {
    const driver = createElasticsearchDriver(applyConfig(CONFIG));
    const fakeDelete = jest.fn().mockResolvedValue({ result: 'deleted' });
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await driver.remove('pX');

    expect(fakeDelete).toHaveBeenCalledTimes(1);
    expect(fakeDelete.mock.calls[0][0]).toEqual({ index: 'crowi-current', id: 'pX' });
  });

  it('remove() swallows 404 (idempotent)', async () => {
    const driver = createElasticsearchDriver(applyConfig(CONFIG));
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const fakeDelete = jest.fn().mockRejectedValue(notFound);
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await expect(driver.remove('missing')).resolves.toBeUndefined();
  });

  it('remove() rethrows non-404 errors', async () => {
    const driver = createElasticsearchDriver(applyConfig(CONFIG));
    const serverErr = Object.assign(new Error('boom'), { statusCode: 500 });
    const fakeDelete = jest.fn().mockRejectedValue(serverErr);
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await expect(driver.remove('pX')).rejects.toThrow('boom');
  });
});

describe('createElasticsearchDriver query() user-count caching', () => {
  it('caches countUsers() across query calls', async () => {
    const countUsers = jest.fn(async () => 42);
    const driver = createElasticsearchDriver(applyConfig(CONFIG), { countUsers });
    const fakeSearch = jest.fn().mockResolvedValue({ hits: { total: 0, hits: [] } });
    (driver.client as unknown as { search: typeof fakeSearch }).search = fakeSearch;

    await driver.query({ q: 'a' });
    await driver.query({ q: 'b' });
    await driver.query({ q: 'c' });

    expect(countUsers).toHaveBeenCalledTimes(1);
  });
});

describe('applyConfig', () => {
  it('builds a connected state from a configured url', () => {
    const state = applyConfig(CONFIG);
    expect(state.client).not.toBeNull();
    expect(state.node).toBe('http://localhost:9200');
    expect(state.baseIndexName).toBe('crowi');
    expect(state.aliasName).toBe('crowi-current');
    expect(state.analyzer).toBe('default');
    expect(state.requestTimeout).toBe(5000);
  });

  it('yields a disabled state (client=null) when url is empty', () => {
    const state = applyConfig({ url: '', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
    expect(state.client).toBeNull();
    expect(state.node).toBe('');
    expect(state.aliasName).toBe('crowi-current');
  });
});

describe('reconfigure: applyConfigInPlace + driver state ref', () => {
  it('swaps state.client and returns the previous client for closing', () => {
    const state = applyConfig(CONFIG);
    const firstClient = state.client;
    const { oldClient } = applyConfigInPlace(state, { ...CONFIG, url: 'http://other:9200/other' });
    expect(oldClient).toBe(firstClient);
    expect(state.client).not.toBe(firstClient);
    expect(state.client).not.toBeNull();
  });

  it('updates baseIndexName / aliasName / analyzer / requestTimeout in place', () => {
    const state = applyConfig(CONFIG);
    applyConfigInPlace(state, { url: 'http://es:9200/wiki', indexName: 'wiki', requestTimeout: 12000, analyzer: 'kuromoji' });
    expect(state.baseIndexName).toBe('wiki');
    expect(state.aliasName).toBe('wiki-current');
    expect(state.analyzer).toBe('kuromoji');
    expect(state.requestTimeout).toBe(12000);
    expect(state.node).toBe('http://es:9200');
  });

  it('a driver bound to the state ref sees the new alias on the next query', async () => {
    const state = applyConfig(CONFIG);
    const driver = createElasticsearchDriver(state);

    const firstSearch = jest.fn().mockResolvedValue({ hits: { total: 0, hits: [] } });
    (state.client as unknown as { search: typeof firstSearch }).search = firstSearch;
    await driver.query({ q: 'before' });
    expect(firstSearch.mock.calls[0][0].index).toBe('crowi-current');

    applyConfigInPlace(state, { ...CONFIG, url: 'http://es:9200/wiki', indexName: 'wiki' });
    const secondSearch = jest.fn().mockResolvedValue({ hits: { total: 0, hits: [] } });
    (state.client as unknown as { search: typeof secondSearch }).search = secondSearch;
    await driver.query({ q: 'after' });
    expect(secondSearch.mock.calls[0][0].index).toBe('wiki-current');
  });

  it('an inflight query() completes on the snapshotted old client despite a mid-flight reconfigure', async () => {
    const state = applyConfig(CONFIG);
    const driver = createElasticsearchDriver(state);
    const oldClient = state.client;

    // Old client's search resolves only after we trigger it explicitly.
    let releaseOldSearch: (() => void) | undefined;
    const oldSearch = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseOldSearch = () => resolve({ hits: { total: 1, hits: [{ _id: 'p1', _source: { path: '/old' } }] } });
        }),
    );
    (oldClient as unknown as { search: typeof oldSearch }).search = oldSearch;

    // Start the query; it snapshots the old client.
    const inflight = driver.query({ q: 'inflight' });
    await Promise.resolve(); // let query() reach the snapshot + await

    // Reconfigure mid-flight: swaps in a brand-new client.
    applyConfigInPlace(state, { ...CONFIG, url: 'http://es:9200/wiki', indexName: 'wiki' });
    expect(state.client).not.toBe(oldClient);

    // The inflight query must still resolve via the OLD client.
    releaseOldSearch?.();
    const result = await inflight;
    expect(oldSearch).toHaveBeenCalledTimes(1);
    expect(result.hits[0].path).toBe('/old');
  });

  it('throws "Search not configured" once url is reconfigured to empty', async () => {
    const state = applyConfig(CONFIG);
    const driver = createElasticsearchDriver(state);
    applyConfigInPlace(state, { ...CONFIG, url: '' });

    await expect(driver.query({ q: 'x' })).rejects.toThrow(/Search not configured/);
    await expect(driver.index({ id: 'p', path: '/p', body: 'b' })).rejects.toThrow(/Search not configured/);
    await expect(driver.remove('p')).rejects.toThrow(/Search not configured/);
    expect(driver.rebuild).toBeDefined();
    await expect(driver.rebuild?.()).rejects.toThrow(/Search not configured/);
  });
});

describe('plugin reconfigure() hook', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pluginModule = require('../index') as typeof import('../index');
  const plugin = pluginModule.default;

  const makeCtx = (config: Record<string, unknown>) => {
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const models: Record<string, unknown> = {
      Page: { allPageCount: async () => 0, getStreamOfFindAll: () => ({ eachAsync: async () => {} }) },
      Bookmark: { aggregate: async () => [] },
      User: { countDocuments: () => ({ exec: async () => 0 }) },
    };
    return {
      log,
      config: <T>() => config as T,
      model: (name: string) => models[name],
      setConfig: async () => {},
      dependencyConfig: <T>() => ({}) as T,
    };
  };

  it('exposes reconfigure (so PluginInfo.supportsHotReload is derived true)', () => {
    expect(typeof plugin.reconfigure).toBe('function');
  });

  it('swaps the live client and closes the previous one fire-and-forget', async () => {
    const { registerSearch, reconfigure } = plugin;
    if (!registerSearch || !reconfigure) throw new Error('plugin must expose registerSearch + reconfigure');

    const registry = { register: jest.fn() };
    const bootCtx = makeCtx({ url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSearch(registry as any, bootCtx as any);

    const driver = registry.register.mock.calls[0][1] as import('../driver').ElasticsearchDriver;
    const firstClient = driver.client;
    const close = jest.fn().mockResolvedValue(undefined);
    (firstClient as unknown as { close: typeof close }).close = close;

    const reCtx = makeCtx({ url: 'http://es:9200/wiki', indexName: 'wiki', requestTimeout: 9000, analyzer: 'kuromoji' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconfigure(reCtx as any);

    expect(driver.baseIndexName).toBe('wiki');
    expect(driver.aliasName).toBe('wiki-current');
    expect(driver.client).not.toBe(firstClient);
    // close() is fire-and-forget but must have been invoked.
    expect(close).toHaveBeenCalledTimes(1);
  });
});
