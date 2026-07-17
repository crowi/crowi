import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import * as fetchOgModule from './fetch-og';
import linkCardPlugin, { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from './index';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stubCtx: RenderContext = { mode: 'view', log: silentLogger };

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

  it('maps a successful fetch to a card RenderResult with no `error` set (so the core never substitutes the generic link-less error placeholder)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'ok', meta: { title: 'Example' } });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/page', pageId: 'p1' }, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('crowi-link-card');
    expect(result.html).toContain('Example');
    expect(result.ttlSec).toBeGreaterThan(0);
  });

  it('maps a non-HTML-content-type fetch-og error to a working-link error card too (AC-3: not a successful degrade)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'unsupported-content-type' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/file.pdf', pageId: 'p1' }, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('crowi-link-card-error');
    expect(result.html).toContain('href="https://example.test/file.pdf"');
  });

  it('maps every fetch-og error to a working-link error card with no `error` set (AC-1: error stays a functioning link)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'blocked' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/blocked', pageId: 'p1' }, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('crowi-link-card-error');
    expect(result.html).toContain('href="https://example.test/blocked"');
  });

  it('gives a persistent-class error (blocked / bad-scheme / unsupported-content-type / 4xx) a longer ttlSec than a transient one (timeout / network / 5xx)', async () => {
    const renderer = createLinkCardRenderer();

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'blocked' });
    const blocked = await renderer.render({ tag: 'card', url: 'https://example.test/a', pageId: 'p1' }, stubCtx);

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 404 });
    const notFound = await renderer.render({ tag: 'card', url: 'https://example.test/b', pageId: 'p1' }, stubCtx);

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'timeout' });
    const timeout = await renderer.render({ tag: 'card', url: 'https://example.test/c', pageId: 'p1' }, stubCtx);

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'http-error', httpStatus: 500 });
    const serverError = await renderer.render({ tag: 'card', url: 'https://example.test/d', pageId: 'p1' }, stubCtx);

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'unsupported-content-type' });
    const unsupportedContentType = await renderer.render({ tag: 'card', url: 'https://example.test/e', pageId: 'p1' }, stubCtx);

    expect(blocked.ttlSec).toBeGreaterThan(timeout.ttlSec ?? 0);
    expect(notFound.ttlSec).toBeGreaterThan(serverError.ttlSec ?? 0);
    expect(timeout.ttlSec).toEqual(serverError.ttlSec);
    expect(unsupportedContentType.ttlSec).toEqual(blocked.ttlSec);
  });
});
