import { Types } from 'mongoose';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { createMongoCacheStorage, RENDER_ERROR_TTL, scopeForPlugin } from '../../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../../pipeline';
import { CORE_RENDERER_IDENTITY, RendererRegistryImpl, createAuthContextStub } from '../../registry';
import * as fetchOgModule from './fetch-og';
import { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from './index';

/**
 * Minimal mdast-shaped node — enough structural surface for
 * `collectHtmlNodeValues` below to recurse without pulling in `mdast`'s
 * full `Node`/`Parent` union.
 */
interface MdastNodeLike {
  type: string;
  value?: string;
  children?: MdastNodeLike[];
}

/** Recursively collect every `html` node's `value` across an ENTIRE tree (not just its first top-level child, unlike `findHtmlNode` below) — used by the many-embeds DoS-repro test, whose body has one `@[card]` per top-level paragraph. */
function collectHtmlNodeValues(tree: MdastNodeLike): string[] {
  const out: string[] = [];
  const visit = (node: MdastNodeLike): void => {
    if (node.type === 'html' && typeof node.value === 'string') out.push(node.value);
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return out;
}

/** Poll `predicate` once per event-loop tick until it's true or `maxTicks` elapses — mirrors `stale-while-revalidate.test.ts`'s `waitFor`, needed here because the many-embeds test's fan-out settles across real (unmocked) Mongo I/O, not a fixed number of microtask flushes. */
async function waitForCondition(predicate: () => boolean, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Yield one event-loop tick — lets a just-released `Promise` (and whatever real async work it triggers) progress before the next assertion. Same helper `fetch-og.test.ts` uses under the same name for its own drain loop. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  it('maps a busy fetch-og code straight through to RenderError code "busy" via the same unified fallback (feature-link-card-fetch-queue-bound)', async () => {
    jest.spyOn(fetchOgModule, 'fetchOg').mockResolvedValueOnce({ kind: 'error', code: 'busy' });
    const renderer = createLinkCardRenderer();
    const result = await renderer.render({ tag: 'card', url: 'https://example.test/congested', pageId: 'p1' }, stubCtx);
    expect(result.error).toEqual({ code: 'busy', message: 'busy' });
    expect(result.html).toBe('');
    // Same unified fallback card as every other fetch-og failure — busy
    // is never visually distinguished (AC5).
    expect(result.errorHtml).toContain('crowi-link-card');
    expect(result.errorHtml).not.toContain('crowi-link-card-error');
    expect(result.errorHtml).toContain('href="https://example.test/congested"');
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

  describe('feature-link-card-fetch-queue-bound', () => {
    it('DoS repro through the REAL page-embed dispatch path: a page body with far more unique-host @[card] embeds than the shared ' +
      'semaphore can hold still bounds outstanding fetch-og acquisitions, resolves every embed to either a real card or the unified ' +
      'busy fallback, and leaves the process able to serve a later dispatch normally (AC3 — the pure-semaphore equivalent in ' +
      'fetch-og.test.ts drives fetchOg() directly with fake timers + hanging hosts; this drives the SAME bound through markdown ' +
      "parse -> embed-tags.ts's Promise.all fan-out -> cachedRender -> the real production shared semaphore, with real timers, " +
      'proving the wiring end-to-end rather than the semaphore in isolation)', async () => {
      const EXTRA_OVER_CAP = 20;
      const ACCEPTED = fetchOgModule.FETCH_CONCURRENCY_LIMIT + fetchOgModule.FETCH_QUEUE_LIMIT; // 55, production bound
      const TOTAL = ACCEPTED + EXTRA_OVER_CAP;

      // Pass-through spy — real `fetchOg` (and therefore the real shared
      // semaphore) still runs; this only lets us count exactly how many
      // times it was ever invoked (AC3(a): must equal TOTAL — one call
      // per candidate, never a second unresolved call for the overflow).
      const realFetchOg = fetchOgModule.fetchOg;
      const fetchOgSpy = jest.spyOn(fetchOgModule, 'fetchOg').mockImplementation((url, deps) => realFetchOg(url, deps));

      // A hanging fetch (manually released below) — nothing accepted
      // into an active/queued slot resolves on its own, so by the time
      // every one of the TOTAL candidates has reached its own fetchOg()
      // call, the accepted/overflow split is final and can never shift,
      // regardless of how the underlying Mongo reads happened to
      // interleave.
      const releasers: Array<() => void> = [];
      let concurrentFetch = 0;
      let maxConcurrentFetch = 0;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            concurrentFetch++;
            maxConcurrentFetch = Math.max(maxConcurrentFetch, concurrentFetch);
            releasers.push(() => {
              concurrentFetch--;
              resolve(htmlResponse('<html><head><meta property="og:title" content="OK"></head></html>'));
            });
          }),
      );

      const { reg, storage, ctx } = buildRegistryAndCtx();
      // Distinct IP-literal hosts — `checkHostnameSsrf`'s literal-address
      // fast path recognises these without a real DNS lookup (same
      // rationale as `TARGET_URL` above). One `@[card]` per paragraph —
      // a page that is nothing but link-card embeds is exactly the
      // attack shape from crowi-review CROWI-REVIEW-002.
      const body = Array.from({ length: TOTAL }, (_, i) => `@[card](http://93.184.216.${(i % 250) + 1}/dos-${i})`).join('\n\n');

      const runPromise = runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

      await waitForCondition(() => fetchOgSpy.mock.calls.length === TOTAL);

      // No accepted fetch has been released yet — any concurrency
      // observed here is real, not an artifact of an early release.
      expect(maxConcurrentFetch).toBeLessThanOrEqual(fetchOgModule.FETCH_CONCURRENCY_LIMIT);

      // Drain: release whatever is in flight so the next queued waiter
      // takes the freed slot, until every accepted request has reached
      // `fetchMock` at least once (mirrors fetch-og.test.ts's own
      // concurrency-cap drain loop).
      while (fetchMock.mock.calls.length < ACCEPTED || releasers.length > 0) {
        const release = releasers.shift();
        release?.();
        await flush();
        expect(maxConcurrentFetch).toBeLessThanOrEqual(fetchOgModule.FETCH_CONCURRENCY_LIMIT);
      }

      const result = await runPromise;

      // AC3(b): every embed resolved and was rewritten in place — none
      // left as a dangling `@[card](...)` — to either a real card
      // (accepted) or the unified busy fallback (overflow).
      const htmlNodes = collectHtmlNodeValues(result.tree as unknown as MdastNodeLike);
      expect(htmlNodes).toHaveLength(TOTAL);
      const successCount = htmlNodes.filter((html) => html.includes('>OK<')).length;
      const fallbackNodes = htmlNodes.filter((html) => html.includes('crowi-link-card') && !html.includes('>OK<'));
      expect(successCount).toBe(ACCEPTED);
      expect(fallbackNodes).toHaveLength(EXTRA_OVER_CAP);
      // AC5: the busy fallback is the SAME unified, clickable-link card
      // as every other fetch failure — never a distinct "busy" variant.
      expect(fallbackNodes[0]).toContain('href="http://93.184.216.');
      expect(fallbackNodes[0]).not.toContain('crowi-link-card-error');

      // AC3(a): fetchOg was invoked exactly once per candidate — the
      // overflow was rejected synchronously inside that one call, never
      // by spawning a second unresolved Promise.
      expect(fetchOgSpy).toHaveBeenCalledTimes(TOTAL);

      // AC3(c): the process is not wedged by the DoS attempt — a fresh,
      // ordinary dispatch against the SAME (now fully-drained)
      // production shared semaphore succeeds normally right after.
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(htmlResponse('<html><head><meta property="og:title" content="After"></head></html>'));
      const { reg: freshReg, storage: freshStorage, ctx: freshCtx } = buildRegistryAndCtx();
      const freshPageId = new Types.ObjectId().toHexString();
      const fresh = await runPipeline('@[card](http://93.184.216.99/after)', freshReg, freshCtx, loadDeps, { cache: freshStorage, pageId: freshPageId });
      expect(collectHtmlNodeValues(fresh.tree as unknown as MdastNodeLike)[0]).toContain('After');
    }, 20_000);

    it('busy renders via the unified fallback with a transient (short) cache TTL, and once the queue frees + that TTL elapses the next dispatch retries the fetch and can succeed (AC6)', async () => {
      const fetchOgSpy = jest.spyOn(fetchOgModule, 'fetchOg');
      fetchOgSpy.mockResolvedValueOnce({ kind: 'error', code: 'busy' });

      const { reg, storage, ctx } = buildRegistryAndCtx();
      const body = `@[card](${TARGET_URL})`;

      const busy = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
      expect(fetchOgSpy).toHaveBeenCalledTimes(1);
      const busyHtml = findHtmlNode(busy.tree);
      expect(busyHtml?.value).toContain('crowi-link-card');
      expect(busyHtml?.value).not.toContain('crowi-link-card-error');
      expect(busyHtml?.value).toContain(`href="${TARGET_URL}"`);

      // The cached entry used busy's transient TTL (RENDER_ERROR_TTL.busy
      // = 5min), never blocked/not_found's 1h persistent bucket.
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const cached = await PluginRenderCache.findOne({ pluginName: CORE_RENDERER_IDENTITY, pageId: new Types.ObjectId(pageId) })
        .lean()
        .exec();
      expect(cached).not.toBeNull();
      const ttlSec = Math.round((cached!.expiresAt.getTime() - cached!.fetchedAt.getTime()) / 1000);
      expect(ttlSec).toBe(RENDER_ERROR_TTL.busy);
      expect(RENDER_ERROR_TTL.busy).toBeLessThan(RENDER_ERROR_TTL.blocked);

      // Simulate the queue draining and busy's transient TTL fully
      // elapsing — push the cached doc's clock into the past with a small
      // ttlMs so `classifyFreshness` sees it well beyond the stale window
      // (same pattern as `stale-while-revalidate.test.ts`; `cachedRender`
      // re-derives freshness from the doc's own fetchedAt/expiresAt, not
      // from `RENDER_ERROR_TTL` directly, so this holds regardless of
      // busy's actual TTL value).
      const past = new Date(Date.now() - 10_000);
      await PluginRenderCache.updateOne(
        { pluginName: CORE_RENDERER_IDENTITY, pageId: new Types.ObjectId(pageId) },
        { $set: { expiresAt: past, fetchedAt: new Date(past.getTime() - 1_000) } },
      ).exec();

      fetchOgSpy.mockResolvedValueOnce({ kind: 'ok', meta: { title: 'Recovered' } });
      const retried = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
      expect(fetchOgSpy).toHaveBeenCalledTimes(2); // retried — busy was never permanent
      expect(findHtmlNode(retried.tree)?.value).toContain('Recovered');
    });
  });
});
