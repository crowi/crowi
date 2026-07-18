import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import * as fetchOgModule from './fetch-og';
import linkCardPlugin, { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from './index';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stubCtx: RenderContext = { mode: 'view', log: silentLogger, actor: { kind: 'user', userId: 'u-test' } };

describe('@crowi/plugin-renderer-link-card plugin contract', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(linkCardPlugin.name).toBe('@crowi/plugin-renderer-link-card');
    expect(typeof linkCardPlugin.version).toBe('string');
    expect(typeof linkCardPlugin.registerRenderer).toBe('function');
  });

  it('has no configSchema — every tunable is an internal constant (spec §"登録・運用")', () => {
    expect(linkCardPlugin.configSchema).toBeUndefined();
  });

  it('registers only addEmbedTag("card", …) — addUrlInlineExpander is intentionally NOT registered (out of scope)', () => {
    const addEmbedTag = jest.fn();
    const addUrlInlineExpander = jest.fn();
    const registry = {
      addUnifiedPlugin: jest.fn(),
      addNodeRenderer: jest.fn(),
      addCodeBlockRenderer: jest.fn(),
      addEmbedTag,
      addUrlInlineExpander,
    };
    linkCardPlugin.registerRenderer?.(registry, { log: silentLogger } as never);
    expect(addEmbedTag).toHaveBeenCalledTimes(1);
    expect(addEmbedTag).toHaveBeenCalledWith('card', expect.objectContaining({ cacheVersion: LINK_CARD_CACHE_VERSION }));
    expect(addUrlInlineExpander).not.toHaveBeenCalled();
  });
});

describe('createLinkCardRenderer — EmbedRenderer contract', () => {
  it('declares a card reservation (layout-stable placeholder)', () => {
    const renderer = createLinkCardRenderer();
    expect(renderer.reservation).toEqual({ variant: 'card', size: 'medium' });
    expect(renderer.cacheVersion).toBe(LINK_CARD_CACHE_VERSION);
  });

  it('maps a successful fetch to a card RenderResult with no `error` set', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'ok', meta: { title: 'Example' } });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/page', pageId: 'p1' }, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.errorHtml).toBeUndefined();
    expect(result.html).toContain('crowi-link-card');
    expect(result.html).toContain('Example');
    expect(result.ttlSec).toBeGreaterThan(0);
  });

  it('maps a non-HTML-content-type fetch-og error to an `error` + working-link `errorHtml` (AC-3: not a successful degrade)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'unsupported-content-type' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/file.pdf', pageId: 'p1' }, stubCtx);
    expect(result.error?.code).toBe('blocked');
    expect(result.html).toBe('');
    expect(result.errorHtml).toContain('crowi-link-card-error');
    expect(result.errorHtml).toContain('href="https://example.test/file.pdf"');
  });

  it('maps every fetch-og error to `error` + a working-link `errorHtml` (AC-1: error stays a functioning link)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'blocked' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/blocked', pageId: 'p1' }, stubCtx);
    expect(result.error?.code).toBe('blocked');
    expect(result.html).toBe('');
    expect(result.errorHtml).toContain('crowi-link-card-error');
    expect(result.errorHtml).toContain('href="https://example.test/blocked"');
  });

  it('maps blocked / bad-scheme / unsupported-content-type to RenderError code "blocked"', async () => {
    const renderer = createLinkCardRenderer();
    for (const code of ['blocked', 'bad-scheme', 'unsupported-content-type'] as const) {
      jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code });
      const result = await renderer.render({ tag: 'card', url: 'https://example.test/x', pageId: 'p1' }, stubCtx);
      expect(result.error).toEqual({ code: 'blocked', message: code });
    }
  });

  it('maps a 4xx http-error to RenderError code "not_found"', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 404 });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/missing', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'not_found', message: 'http-error (HTTP 404)' });
  });

  it('maps a 5xx http-error to RenderError code "network"', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 500 });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/broken', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'network', message: 'http-error (HTTP 500)' });
  });

  it('maps a 429 http-error WITH a parsed Retry-After to RenderError code "rate_limit" + retryAfterSec', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 429, retryAfterSec: 30 });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/too-many', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'rate_limit', message: 'http-error (HTTP 429)', retryAfterSec: 30 });
  });

  it('maps a 429 http-error WITHOUT a Retry-After to the general 4xx "not_found" code (no invented cadence)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 429 });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/too-many-no-header', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'not_found', message: 'http-error (HTTP 429)' });
  });

  it('maps a redirect-exhausted 3xx http-error to RenderError code "network" (transient — matches pre-migration TTL, NOT the persistent "not_found" 4xx bucket)', async () => {
    const renderer = createLinkCardRenderer();
    for (const httpStatus of [301, 302, 303, 307, 308]) {
      jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus });
      const result = await renderer.render({ tag: 'card', url: 'https://example.test/too-many-redirects', pageId: 'p1' }, stubCtx);
      expect(result.error).toEqual({ code: 'network', message: `http-error (HTTP ${httpStatus})` });
    }
  });

  it('maps an http-error with no httpStatus at all to RenderError code "network" (transient fallback, matches pre-migration TTL)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/no-status', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'network', message: 'http-error' });
  });

  it('maps timeout / network fetch-og codes straight through to the same-named RenderError code', async () => {
    const renderer = createLinkCardRenderer();

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'timeout' });
    const timeout = await renderer.render({ tag: 'card', url: 'https://example.test/slow', pageId: 'p1' }, stubCtx);
    expect(timeout.error).toEqual({ code: 'timeout', message: 'timeout' });

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'network' });
    const network = await renderer.render({ tag: 'card', url: 'https://example.test/unreachable', pageId: 'p1' }, stubCtx);
    expect(network.error).toEqual({ code: 'network', message: 'network' });
  });

  it('maps too-large / unknown fetch-og codes to RenderError code "unknown"', async () => {
    const renderer = createLinkCardRenderer();

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'too-large' });
    const tooLarge = await renderer.render({ tag: 'card', url: 'https://example.test/huge', pageId: 'p1' }, stubCtx);
    expect(tooLarge.error).toEqual({ code: 'unknown', message: 'too-large' });

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'unknown' });
    const unknown = await renderer.render({ tag: 'card', url: 'https://example.test/weird', pageId: 'p1' }, stubCtx);
    expect(unknown.error).toEqual({ code: 'unknown', message: 'unknown' });
  });
});
