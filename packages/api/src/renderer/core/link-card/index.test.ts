import { Types } from 'mongoose';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { createMongoCacheStorage, scopeForPlugin } from '../../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../../pipeline';
import { CORE_RENDERER_IDENTITY, RendererRegistryImpl, createAuthContextStub } from '../../registry';
import * as fetchOgModule from './fetch-og';
import { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from './index';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stubCtx: RenderContext = { mode: 'view', log: silentLogger, actor: { kind: 'user', userId: 'u-test' } };

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

  it('maps a non-HTML-content-type fetch-og error to an `error` + working-link unified fallback `errorHtml` (AC-3: not a successful degrade)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'unsupported-content-type' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/file.pdf', pageId: 'p1' }, stubCtx);
    expect(result.error?.code).toBe('blocked');
    expect(result.html).toBe('');
    expect(result.errorHtml).toContain('crowi-link-card');
    expect(result.errorHtml).not.toContain('crowi-link-card-error');
    expect(result.errorHtml).toContain('href="https://example.test/file.pdf"');
  });

  it('maps every fetch-og error to `error` + a working-link unified fallback `errorHtml` (AC-1: error stays a functioning link)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'error', code: 'blocked' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/blocked', pageId: 'p1' }, stubCtx);
    expect(result.error?.code).toBe('blocked');
    expect(result.html).toBe('');
    expect(result.errorHtml).toContain('crowi-link-card');
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

describe('createLinkCardRenderer — security:linkCardEnabled toggle (spec §6.2, AC5/AC7)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('disabled: never calls fetchOg (zero DNS/HTTP) and returns the unified fallback card as a non-error result', async () => {
    const fetchOgSpy = jest.spyOn(fetchOgModule, 'fetchOg');
    const renderer = createLinkCardRenderer({ isLinkCardEnabled: () => false });
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/toggled-off', pageId: 'p1' }, stubCtx);

    expect(fetchOgSpy).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('crowi-link-card');
    expect(result.html).toContain('https://example.test/toggled-off');
  });

  it('disabled output is byte-identical to a fetch-failure fallback for the same url (unified fallback, spec §6.1)', async () => {
    const url = 'https://example.test/same-url';
    const disabledRenderer = createLinkCardRenderer({ isLinkCardEnabled: () => false });
    const disabledResult = await disabledRenderer.render({ tag: 'card', url, pageId: 'p1' }, stubCtx);

    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'network' });
    const failureRenderer = createLinkCardRenderer({ isLinkCardEnabled: () => true });
    const failureResult = await failureRenderer.render({ tag: 'card', url, pageId: 'p1' }, stubCtx);

    expect(disabledResult.html).toBe(failureResult.errorHtml);
  });

  it('enabled (default deps): falls through to the real fetchOg-driven path', async () => {
    const fetchOgSpy = jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'ok', meta: {} });
    const renderer = createLinkCardRenderer();
    await renderer.render({ tag: 'card', url: 'https://example.test/enabled', pageId: 'p1' }, stubCtx);
    expect(fetchOgSpy).toHaveBeenCalledTimes(1);
  });

  it('reads isLinkCardEnabled() live on every render() call — a later flip is observed by the next dispatch without rebuilding the renderer', async () => {
    let enabled = true;
    const renderer = createLinkCardRenderer({ isLinkCardEnabled: () => enabled });
    const fetchOgSpy = jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValue({ kind: 'ok', meta: {} });

    await renderer.render({ tag: 'card', url: 'https://example.test/live-1', pageId: 'p1' }, stubCtx);
    expect(fetchOgSpy).toHaveBeenCalledTimes(1);

    enabled = false;
    await renderer.render({ tag: 'card', url: 'https://example.test/live-2', pageId: 'p1' }, stubCtx);
    expect(fetchOgSpy).toHaveBeenCalledTimes(1); // no new call — still 1
  });

  it('declares shouldBypassCache() mirroring isLinkCardEnabled(), read live per call — the generic dispatcher (embed-tags.ts) uses this to skip CacheStorage entirely while disabled', () => {
    let enabled = true;
    const renderer = createLinkCardRenderer({ isLinkCardEnabled: () => enabled });
    const input = { tag: 'card', url: 'https://example.test/x', pageId: 'p1' };

    expect(renderer.shouldBypassCache?.(input)).toBe(false);
    enabled = false;
    expect(renderer.shouldBypassCache?.(input)).toBe(true);
  });
});

/**
 * e2e coverage through the REAL `@[tag](url)` dispatch + Mongo-backed
 * cache (`cachedRender`) — moved from
 * `packages/api/src/renderer/__fixtures__/link-card.e2e.test.ts`
 * (deleted; that fixture drove the plugin through
 * `makeRendererScope(...).addEmbedTag(...)`, which no longer applies
 * now that `card` is a CORE-reserved tag seeded via
 * `RendererRegistryImpl.addCoreEmbedTag`).
 */
describe('e2e: core `card` embed tag through the real registry/pipeline/cache', () => {
  let pageId: string;
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: jest.Mock;

  const loadDeps = createPipelineEsmDepsLoader();

  // A public IP-literal target: `checkHostnameSsrf` allows it via the
  // literal-address fast path, so no `dns.lookup` (and therefore no
  // real DNS traffic) is ever involved — the mocked `globalThis.fetch`
  // below is the only thing standing between this test and the
  // network, so these tests never touch it.
  const TARGET_URL = 'http://93.184.216.34/page';

  const OGP_HTML = [
    '<html><head>',
    '<meta property="og:title" content="Example Title">',
    '<meta property="og:description" content="Example description.">',
    '</head><body></body></html>',
  ].join('');

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Partial<{ fetch: unknown }>).fetch;
    }
  });

  function htmlResponse(html: string): Response {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  function findHtmlNode(tree: { children: unknown[] }): { value: string } | undefined {
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    return para.children.find((c) => c.type === 'html') as { value: string } | undefined;
  }

  function buildRegistryAndCtx(deps: Parameters<typeof createLinkCardRenderer>[0] = { isLinkCardEnabled: () => true }) {
    const reg = new RendererRegistryImpl();
    reg.addCoreEmbedTag('card', createLinkCardRenderer(deps));
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, CORE_RENDERER_IDENTITY),
      auth: createAuthContextStub(),
    };
    return { reg, storage, ctx };
  }

  it('renders `@[card](url)` into a card html node carrying the fetched OGP title/description/domain', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const { reg, storage, ctx } = buildRegistryAndCtx();

    const body = `See @[card](${TARGET_URL}) here.`;
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const html = findHtmlNode(result.tree);
    expect(html?.value).toContain('crowi-link-card');
    expect(html?.value).toContain('Example Title');
    expect(html?.value).toContain('Example description.');
    expect(html?.value).toContain('93.184.216.34');
  });

  it('caches the card and skips the fetch on a second run with the same body + pageId', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const { reg: reg1, storage, ctx } = buildRegistryAndCtx();
    const body = `@[card](${TARGET_URL})`;

    await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second run — fresh registry, same body + pageId → cache hit.
    fetchMock.mockClear();
    const { reg: reg2 } = buildRegistryAndCtx();
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findHtmlNode(second.tree)?.value).toContain('crowi-link-card');
  });

  it('a cacheVersion bump forces a fresh fetch instead of serving the stale cached entry', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const { reg: reg1, storage, ctx } = buildRegistryAndCtx();
    const body = `@[card](${TARGET_URL})`;

    await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a rendered-HTML shape change: same render logic, one
    // higher `cacheVersion`. `pluginCacheVersion` is part of the cache
    // key (`cache/index.ts:cacheKeyString`), so this must be a distinct
    // entry — the v1 cache must NOT serve this request.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const bumpedRenderer = { ...createLinkCardRenderer(), cacheVersion: LINK_CARD_CACHE_VERSION + 1 };
    const reg2 = new RendererRegistryImpl();
    reg2.addCoreEmbedTag('card', bumpedRenderer);

    await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an SSRF-blocked target renders the unified fallback card (not the core generic placeholder) without ever calling fetch', async () => {
    const { reg, storage, ctx } = buildRegistryAndCtx();
    const body = '@[card](http://127.0.0.1/admin)';

    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();

    const html = findHtmlNode(result.tree);
    expect(html?.value).toContain('crowi-link-card');
    expect(html?.value).not.toContain('crowi-link-card-error');
    expect(html?.value).toContain('href="http://127.0.0.1/admin"');
    // AC-1: the failure card stays a functioning link — the core's
    // generic link-less placeholder (`reservation.ts:errorPlaceholder`)
    // must never be substituted for it.
    expect(html?.value).not.toContain('crowi-embed-placeholder-error');
  });

  it('toggle disabled: a fresh dispatch renders the unified fallback card and never calls fetch — zero DNS/HTTP (spec §9(b))', async () => {
    const { reg, storage, ctx } = buildRegistryAndCtx({ isLinkCardEnabled: () => false });
    const body = `@[card](${TARGET_URL})`;

    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();

    const html = findHtmlNode(result.tree);
    expect(html?.value).toContain('crowi-link-card');
    expect(html?.value).toContain(TARGET_URL);
  });

  it('warm cache from an enabled render, then disable: the disabled dispatch bypasses the cache — zero fetch AND does NOT serve the stale cached OGP card (AC5)', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const { reg: reg1, storage, ctx } = buildRegistryAndCtx({ isLinkCardEnabled: () => true });
    const body = `@[card](${TARGET_URL})`;

    const enabled = await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(findHtmlNode(enabled.tree)?.value).toContain('Example Title');

    // Disable — SAME storage, still warm with the OGP card cached above.
    // A dispatcher that consulted the cache before the toggle check
    // would return that cached OGP card here; `shouldBypassCache` must
    // skip the cache read entirely instead.
    fetchMock.mockClear();
    const { reg: reg2 } = buildRegistryAndCtx({ isLinkCardEnabled: () => false });
    const disabled = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });

    expect(fetchMock).not.toHaveBeenCalled();
    const html = findHtmlNode(disabled.tree);
    expect(html?.value).not.toContain('Example Title'); // NOT the stale cached OGP card
    expect(html?.value).toContain(TARGET_URL); // the unified fallback card instead
  });

  it('disable then re-enable: the disabled dispatch never writes to the cache, so re-enabling re-fetches immediately instead of serving a stale fallback for the TTL window (AC7)', async () => {
    const { reg: reg1, storage, ctx } = buildRegistryAndCtx({ isLinkCardEnabled: () => false });
    const body = `@[card](${TARGET_URL})`;

    const disabled = await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findHtmlNode(disabled.tree)?.value).toContain(TARGET_URL);

    // Re-enable — SAME storage. If the disabled dispatch above had
    // written the fallback card to the cache, this would serve it back
    // fresh (within its TTL) instead of dispatching a real fetch.
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const { reg: reg2 } = buildRegistryAndCtx({ isLinkCardEnabled: () => true });
    const enabled = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(findHtmlNode(enabled.tree)?.value).toContain('Example Title');
  });

  it('a third-party plugin cannot shadow the core-reserved "card" tag — addEmbedTag throws', () => {
    const reg = new RendererRegistryImpl();
    reg.addCoreEmbedTag('card', createLinkCardRenderer());
    expect(() => reg.addEmbedTag('card', createLinkCardRenderer(), 'some-plugin', silentLogger)).toThrow(/reserved/);
    // The core registration survives the attempted collision.
    expect(reg.getEmbedTag('card')?.plugin).toBe(CORE_RENDERER_IDENTITY);
  });
});
