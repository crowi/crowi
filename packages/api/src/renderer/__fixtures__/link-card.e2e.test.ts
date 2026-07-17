import { Types } from 'mongoose';
import type { PluginContext, PluginLogger, RenderContext } from '@crowi/plugin-api';
import linkCardPlugin, { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from '@crowi/plugin-renderer-link-card';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';

/**
 * e2e coverage for `@crowi/plugin-renderer-link-card` through the REAL
 * `@[tag](url)` dispatch + Mongo-backed cache (`cachedRender`) — same
 * shape as the sibling `plantuml.e2e.test.ts` / `echo-embed.e2e.test.ts`.
 * Reviewer advisory: the plugin's own unit tests (`index.test.ts`,
 * `fetch-og.test.ts`) already cover `cacheVersion`/`ttlSec` at the
 * `EmbedRenderer.render()` level in isolation, but nothing previously
 * exercised this plugin's actual wiring (`addEmbedTag('card', …)` →
 * `cachedRender` → `PluginRenderCache`) end-to-end. These 4 tests close
 * that gap: a real fetch/cache-hit/cacheVersion-invalidation/SSRF-block
 * round trip through the full pipeline.
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-renderer-link-card';

// A public IP-literal target: `checkHostnameSsrf` allows it via the
// literal-address fast path, so no `dns.lookup` (and therefore no real
// DNS traffic) is ever involved — the mocked `globalThis.fetch` below
// is the only thing standing between this test and the network, so
// these tests never touch it.
const TARGET_URL = 'http://93.184.216.34/page';

const OGP_HTML = [
  '<html><head>',
  '<meta property="og:title" content="Example Title">',
  '<meta property="og:description" content="Example description.">',
  '</head><body></body></html>',
].join('');

const stubPluginCtx: PluginContext = { log: silentLogger } as PluginContext;

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function findHtmlNode(tree: { children: unknown[] }): { value: string } | undefined {
  const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
  return para.children.find((c) => c.type === 'html') as { value: string } | undefined;
}

describe('e2e: @crowi/plugin-renderer-link-card', () => {
  let pageId: string;
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: jest.Mock;

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

  function buildRegistryAndCtx() {
    const reg = new RendererRegistryImpl();
    linkCardPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
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
    const reg2 = new RendererRegistryImpl();
    linkCardPlugin.registerRenderer?.(makeRendererScope(reg2, PLUGIN, silentLogger), stubPluginCtx);
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

    // Simulate the plugin bumping `LINK_CARD_CACHE_VERSION` after a
    // rendered-HTML shape change: same render logic, one higher
    // `cacheVersion`. `pluginCacheVersion` is part of the cache key
    // (`cache/index.ts:cacheKeyString`), so this must be a distinct
    // entry — the v1 cache must NOT serve this request.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(htmlResponse(OGP_HTML));
    const bumpedRenderer = { ...createLinkCardRenderer(), cacheVersion: LINK_CARD_CACHE_VERSION + 1 };
    const reg2 = new RendererRegistryImpl();
    makeRendererScope(reg2, PLUGIN, silentLogger).addEmbedTag('card', bumpedRenderer);

    await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an SSRF-blocked target renders a working-link error card (not the core generic placeholder) without ever calling fetch', async () => {
    const { reg, storage, ctx } = buildRegistryAndCtx();
    const body = '@[card](http://127.0.0.1/admin)';

    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();

    const html = findHtmlNode(result.tree);
    expect(html?.value).toContain('crowi-link-card-error');
    expect(html?.value).toContain('href="http://127.0.0.1/admin"');
    // AC-1: the error stays a functioning link — the core's generic
    // link-less placeholder (`reservation.ts:errorPlaceholder`) must
    // never be substituted for it.
    expect(html?.value).not.toContain('crowi-embed-placeholder-error');
  });
});
