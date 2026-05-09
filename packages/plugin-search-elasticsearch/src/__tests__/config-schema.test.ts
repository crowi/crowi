import plugin, { ElasticsearchConfigSchema } from '../index';

describe('ElasticsearchConfigSchema', () => {
  it('parses an empty input and applies defaults', () => {
    const out = ElasticsearchConfigSchema.parse({});
    expect(out).toEqual({ url: '', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => ElasticsearchConfigSchema.parse({ extra: 'oops' })).toThrow();
  });

  it('rejects unknown analyzer', () => {
    expect(() => ElasticsearchConfigSchema.parse({ analyzer: 'mecab' })).toThrow();
  });

  it('rejects negative requestTimeout', () => {
    expect(() => ElasticsearchConfigSchema.parse({ requestTimeout: -1 })).toThrow();
  });
});

describe('plugin default export', () => {
  it('declares CrowiPlugin metadata', () => {
    expect(plugin.name).toBe('@crowi/plugin-search-elasticsearch');
    expect(typeof plugin.version).toBe('string');
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.registerSearch).toBe('function');
  });
});
