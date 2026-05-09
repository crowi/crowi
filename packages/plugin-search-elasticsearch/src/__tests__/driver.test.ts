import { createElasticsearchDriver, docToEsSource, parseUri } from '../driver';
import type { SearchableDoc } from '@crowi/plugin-api';

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
    const driver = createElasticsearchDriver(
      { url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' },
      { countUsers: async () => 5 },
    );
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
    const driver = createElasticsearchDriver({ url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
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
    const driver = createElasticsearchDriver({ url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
    const fakeDelete = jest.fn().mockResolvedValue({ result: 'deleted' });
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await driver.remove('pX');

    expect(fakeDelete).toHaveBeenCalledTimes(1);
    expect(fakeDelete.mock.calls[0][0]).toEqual({ index: 'crowi-current', id: 'pX' });
  });

  it('remove() swallows 404 (idempotent)', async () => {
    const driver = createElasticsearchDriver({ url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const fakeDelete = jest.fn().mockRejectedValue(notFound);
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await expect(driver.remove('missing')).resolves.toBeUndefined();
  });

  it('remove() rethrows non-404 errors', async () => {
    const driver = createElasticsearchDriver({ url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
    const serverErr = Object.assign(new Error('boom'), { statusCode: 500 });
    const fakeDelete = jest.fn().mockRejectedValue(serverErr);
    (driver.client as unknown as { delete: typeof fakeDelete }).delete = fakeDelete;

    await expect(driver.remove('pX')).rejects.toThrow('boom');
  });
});

describe('createElasticsearchDriver query() user-count caching', () => {
  it('caches countUsers() across query calls', async () => {
    const countUsers = jest.fn(async () => 42);
    const driver = createElasticsearchDriver(
      { url: 'http://localhost:9200/crowi', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' },
      { countUsers },
    );
    const fakeSearch = jest.fn().mockResolvedValue({ hits: { total: 0, hits: [] } });
    (driver.client as unknown as { search: typeof fakeSearch }).search = fakeSearch;

    await driver.query({ q: 'a' });
    await driver.query({ q: 'b' });
    await driver.query({ q: 'c' });

    expect(countUsers).toHaveBeenCalledTimes(1);
  });
});
