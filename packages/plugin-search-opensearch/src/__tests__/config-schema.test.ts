import plugin, { OpenSearchConfigSchema } from '../index';

describe('OpenSearchConfigSchema', () => {
  it('parses an empty input and applies defaults', () => {
    const out = OpenSearchConfigSchema.parse({});
    expect(out).toEqual({ url: '', indexName: 'crowi', requestTimeout: 5000, analyzer: 'default' });
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => OpenSearchConfigSchema.parse({ extra: 'oops' })).toThrow();
  });

  it('rejects unknown analyzer', () => {
    expect(() => OpenSearchConfigSchema.parse({ analyzer: 'mecab' })).toThrow();
  });

  it('rejects negative requestTimeout', () => {
    expect(() => OpenSearchConfigSchema.parse({ requestTimeout: -1 })).toThrow();
  });

  it('marks url as @sensitive (encrypted at rest)', () => {
    // The runtime config namespace strips fields with the @sensitive
    // marker from non-admin reads and encrypts them before persisting.
    // We assert the marker is on the description so a refactor doesn't
    // silently lose the encryption guarantee.
    const shape = OpenSearchConfigSchema.shape;
    expect(shape.url.description).toMatch(/@sensitive/);
  });
});

describe('plugin default export', () => {
  it('declares CrowiPlugin metadata', () => {
    expect(plugin.name).toBe('@crowi/plugin-search-opensearch');
    expect(typeof plugin.version).toBe('string');
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.registerSearch).toBe('function');
  });

  it('does not define onInstall (legacy env auto-migration is intentionally absent)', () => {
    // The Crowi 2.0 admin UI is the single source of truth for the
    // OpenSearch URL; we do not migrate legacy env values into the
    // plugin config namespace. See spec for rationale.
    expect(plugin.onInstall).toBeUndefined();
  });

  // feature-plugin-capability-scoping: declares exactly the models it
  // reads (read-only) via ctx.model() in registerSearch — see index.ts.
  it('declares modelAccess for the models it reads via ctx.model()', () => {
    expect(plugin.modelAccess).toEqual(['Page', 'Bookmark', 'User']);
  });
});
