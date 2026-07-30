import type { CodeBlockRenderer, EmbedRenderer, PluginLogger, RenderContext, StructuredRenderPayload } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import { Types } from 'mongoose';
import type { PluginRenderCacheDocument, PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { createMongoCacheStorage, scopeForPlugin } from './cache';
import { PER_PAGE_STRUCTURED_REJECT_BYTES, SINGLE_ENTRY_REJECT_BYTES } from './cache/mongodb-cache';
import { makeCodeBlockDispatch, redispatchPendingCodeBlocks } from './core/code-block-dispatch';
import { makeEmbedTagDispatch } from './core/embed-tags';
import { createLinkCardRenderer, LINK_CARD_CACHE_VERSION } from './core/link-card';
import { renderFallbackCard } from './core/link-card/render-card';
import { createAuthContextStub, RendererRegistryImpl } from './registry';

/**
 * RFC-0023 §10/§11 — structured render cache (independent budgets,
 * effective-result contract, stale-if-error carry) asserted at the
 * level that matters: the AST node the dispatch actually splices.
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PLUGIN = '@crowi/plugin-fixture-structured';

const buildCtx = (storage: ReturnType<typeof createMongoCacheStorage>, pluginName: string): RenderContext => ({
  mode: 'view',
  log: silentLogger,
  actor: { kind: 'system' },
  cache: scopeForPlugin(storage, pluginName),
  auth: createAuthContextStub(),
});

const diagramStructured = (marker = 'ok'): StructuredRenderPayload => ({
  node: {
    type: 'crowiDiagram',
    kind: 'mermaid',
    alt: `diagram-${marker}`,
    image: { mediaType: 'image/svg+xml', base64: 'aGVsbG8=', width: 10, height: 10 },
  },
});

const codeTree = (lang: string, source = 'graph TD'): Root => ({ type: 'root', children: [{ type: 'code', lang, value: source }] }) as unknown as Root;

type HtmlNode = { type: string; value: string; data?: Record<string, unknown> };

const firstChild = (tree: Root): HtmlNode => (tree as unknown as { children: HtmlNode[] }).children[0];

const storage = () => createMongoCacheStorage(crowi);
const cacheModel = () => crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;

let langSeq = 0;
const nextLang = () => `structlang${langSeq++}`;

const registerCodeBlock = (registry: RendererRegistryImpl, lang: string, renderer: CodeBlockRenderer) => {
  registry.addCodeBlockRenderer(lang, renderer, PLUGIN, silentLogger);
};

describe('MongoCacheStorage — independent html / structured budgets (§11)', () => {
  it('persists structured within budget and round-trips it through get(); structuredBytes column is set', async () => {
    const cache = storage();
    const key = { pluginName: PLUGIN, pluginCacheVersion: 1, pageId: new Types.ObjectId().toHexString(), embedKey: 'ok' };
    const structured = diagramStructured();
    const verdict = await cache.setOrReject(key, {
      html: '<div>ok</div>',
      result: { html: '<div>ok</div>', structured },
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(verdict).toEqual({ reject: null, structuredStripped: false });
    const got = await cache.get(key);
    expect(got?.result.structured).toEqual(structured);
    const doc = (await cacheModel().findOne({ embedKey: 'ok', pluginName: PLUGIN }).lean().exec()) as PluginRenderCacheDocument | null;
    expect(doc?.structuredBytes).toBeGreaterThan(0);
  });

  it('a legacy-diagram-sized html (warn<html<reject) with an over-100KB structured copy: html writes untouched, structured strips', async () => {
    const cache = storage();
    const key = { pluginName: PLUGIN, pluginCacheVersion: 1, pageId: new Types.ObjectId().toHexString(), embedKey: 'strip' };
    const html = 'h'.repeat(60 * 1024); // between warn and reject — passes today, must keep passing
    const structured: StructuredRenderPayload = { node: { type: 'crowiDiagram', big: 'S'.repeat(SINGLE_ENTRY_REJECT_BYTES + 1024) } };
    const verdict = await cache.setOrReject(key, {
      html,
      result: { html, structured },
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(verdict).toEqual({ reject: null, structuredStripped: true });
    const got = await cache.get(key);
    expect(got?.html).toBe(html);
    expect(got?.result.structured).toBeUndefined();
    const doc = (await cacheModel().findOne({ embedKey: 'strip', pluginName: PLUGIN }).lean().exec()) as PluginRenderCacheDocument | null;
    expect(doc?.structuredBytes).toBe(0);
  });

  it('per-page structured quota consumes the structuredBytes column: exceeding it strips structured but writes html', async () => {
    const cache = storage();
    const pageId = new Types.ObjectId();
    // Seed the page with rows already carrying ~PER_PAGE quota of
    // structured bytes (column-level seed — the aggregate is the
    // consumer under test).
    await cacheModel().create({
      pluginName: PLUGIN,
      pluginCacheVersion: 1,
      pageId,
      embedKey: 'seed',
      html: '<div>seed</div>',
      htmlBytes: 100,
      structuredBytes: PER_PAGE_STRUCTURED_REJECT_BYTES - 10 * 1024,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      result: { html: '<div>seed</div>' },
    });
    const key = { pluginName: PLUGIN, pluginCacheVersion: 1, pageId: pageId.toHexString(), embedKey: 'over-quota' };
    const structured: StructuredRenderPayload = { node: { type: 'crowiDiagram', pad: 'p'.repeat(20 * 1024) } };
    const verdict = await cache.setOrReject(key, {
      html: '<div>fits</div>',
      result: { html: '<div>fits</div>', structured },
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(verdict).toEqual({ reject: null, structuredStripped: true });
    const got = await cache.get(key);
    expect(got?.html).toBe('<div>fits</div>');
    expect(got?.result.structured).toBeUndefined();
  });
});

describe('dispatch effective results (§10) — asserted on the spliced AST node', () => {
  it('miss → render: html node carries the schema-validated sidecar from the SAME render outcome', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => ({ html: '<div class="diagram">D</div>', structured: diagramStructured('fresh'), ttlSec: 3600 }),
    });
    const cache = storage();
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = firstChild(tree);
    expect(node.type).toBe('html');
    expect(node.value).toBe('<div class="diagram">D</div>');
    expect((node.data?.crowiDiagram as { alt: string }).alt).toBe('diagram-fresh');
  });

  it('cache hit (fresh): the sidecar comes from the cached entry', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    let calls = 0;
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => {
        calls += 1;
        return { html: '<div>hit</div>', structured: diagramStructured('cached'), ttlSec: 3600 };
      },
    });
    const cache = storage();
    const pageId = new Types.ObjectId().toHexString();
    const deps = { cache, pageId };
    const ctx = buildCtx(cache, PLUGIN);
    await makeCodeBlockDispatch(registry, ctx, deps)(codeTree(lang));
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, ctx, deps)(tree);
    expect(calls).toBe(1); // second dispatch was a fresh cache hit
    expect((firstChild(tree).data?.crowiDiagram as { alt: string }).alt).toBe('diagram-cached');
  });

  it('html size-limit reject: html AND sidecar both become the size-limit placeholder (one selection)', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => ({ html: 'x'.repeat(SINGLE_ENTRY_REJECT_BYTES + 1), structured: diagramStructured('oversize'), ttlSec: 3600 }),
    });
    const cache = storage();
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = firstChild(tree);
    expect(node.value).toContain('crowi-embed-placeholder-error-size-limit');
    expect((node.data?.crowiPlaceholder as { kind: string }).kind).toBe('size-limit-entry');
  });

  it('structured-only strip: dispatch splices a sidecar-less plain html node (web display untouched, no placeholder substitution)', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    const oversizeStructured: StructuredRenderPayload = { node: { type: 'crowiDiagram', pad: 'p'.repeat(SINGLE_ENTRY_REJECT_BYTES + 1024) } };
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => ({ html: '<div>html-fine</div>', structured: oversizeStructured, ttlSec: 3600 }),
    });
    const cache = storage();
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = firstChild(tree);
    expect(node.value).toBe('<div>html-fine</div>');
    expect(node.data).toBeUndefined();
  });

  it('a schema-invalid structured payload from a plugin degrades to a sidecar-less html node (mapper validation boundary)', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => ({ html: '<div>bad-structured</div>', structured: { node: { type: 'crowiDiagram', missingEverything: true } }, ttlSec: 3600 }),
    });
    const cache = storage();
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = firstChild(tree);
    expect(node.value).toBe('<div>bad-structured</div>');
    expect(node.data).toBeUndefined();
  });

  it('non-throw normalisation (§11): a structured payload whose stringify throws never breaks the write — html lands, sidecar absent', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    const poisoned: StructuredRenderPayload = {
      node: {
        type: 'crowiDiagram',
        get boom(): never {
          throw new Error('poisoned getter');
        },
      } as unknown as Record<string, unknown>,
    };
    registerCodeBlock(registry, lang, { cacheVersion: 1, render: () => ({ html: '<div>poison</div>', structured: poisoned, ttlSec: 3600 }) });
    const cache = storage();
    const tree = codeTree(lang);
    await expect(
      makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree),
    ).resolves.toBeUndefined();
    const node = firstChild(tree);
    expect(node.value).toBe('<div>poison</div>');
    expect(node.data).toBeUndefined();
  });

  it('circular structured payloads are equally survivable', async () => {
    const circularNode: Record<string, unknown> = { type: 'crowiDiagram' };
    circularNode.self = circularNode;
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    registerCodeBlock(registry, lang, { cacheVersion: 1, render: () => ({ html: '<div>circle</div>', structured: { node: circularNode }, ttlSec: 3600 }) });
    const cache = storage();
    const tree = codeTree(lang);
    await expect(
      makeCodeBlockDispatch(registry, buildCtx(cache, PLUGIN), { cache, pageId: new Types.ObjectId().toHexString() })(tree),
    ).resolves.toBeUndefined();
    expect(firstChild(tree).value).toBe('<div>circle</div>');
  });

  it('stale-if-error: a later failing render keeps last-good html AND its structured together (dispatch still stamps the sidecar)', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    let failing = false;
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      render: () => {
        if (failing) return { html: '', error: { code: 'network' as const, message: 'down' } };
        return { html: '<div>good</div>', structured: diagramStructured('lastgood'), ttlSec: 3600 };
      },
    });
    const cache = storage();
    const pageId = new Types.ObjectId().toHexString();
    const ctx = buildCtx(cache, PLUGIN);
    await makeCodeBlockDispatch(registry, ctx, { cache, pageId })(codeTree(lang));
    // Force the entry past the whole SWR window so the next dispatch
    // blocks on a re-render (which will fail).
    const past = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await cacheModel()
      .updateMany({ pageId: new Types.ObjectId(pageId) }, { $set: { fetchedAt: past, expiresAt: new Date(past.getTime() + 1000) } })
      .exec();
    failing = true;
    const tree = codeTree(lang);
    await makeCodeBlockDispatch(registry, ctx, { cache, pageId })(tree);
    const node = firstChild(tree);
    expect(node.value).toBe('<div>good</div>');
    expect((node.data?.crowiDiagram as { alt: string }).alt).toBe('diagram-lastgood');
  });

  it('redispatchPendingCodeBlocks (splice path 3) stamps the sidecar on the retried node', async () => {
    const registry = new RendererRegistryImpl();
    const lang = nextLang();
    registerCodeBlock(registry, lang, {
      cacheVersion: 1,
      admissionControl: { maxConcurrentGlobal: 2, maxConcurrentPerUser: 2, queueDepth: 10 },
      render: () => ({ html: '<div>recovered</div>', structured: diagramStructured('recovered'), ttlSec: 3600 }),
    });
    const cache = storage();
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang, value: 'src', data: { renderPending: true } }],
    } as unknown as Root;
    const { changed } = await redispatchPendingCodeBlocks(tree, registry, buildCtx(cache, PLUGIN), {
      cache,
      pageId: new Types.ObjectId().toHexString(),
    });
    expect(changed).toBe(true);
    const node = firstChild(tree);
    expect(node.type).toBe('html');
    expect(node.value).toBe('<div>recovered</div>');
    expect((node.data?.crowiDiagram as { alt: string }).alt).toBe('diagram-recovered');
  });
});

describe('link-card — toggle-off and fetch-failure are html- AND sidecar-identical (§10)', () => {
  const embedTree = (url: string): Root =>
    ({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '@' },
            { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
          ],
        },
      ],
    }) as unknown as Root;

  const cardNodeOf = (tree: Root): HtmlNode => {
    const paragraph = (tree as unknown as { children: Array<{ children: HtmlNode[] }> }).children[0];
    const html = paragraph.children.find((c) => c.type === 'html');
    if (!html) throw new Error('no html node spliced');
    return html;
  };

  it('LINK_CARD_CACHE_VERSION is 2 (RFC-0023 §13 — structured sidecar addition invalidates pre-existing rows)', () => {
    expect(LINK_CARD_CACHE_VERSION).toBe(2);
  });

  it('toggle OFF goes through the shouldBypassCache path and still gets the {url}-only crowiLinkCard sidecar', async () => {
    const registry = new RendererRegistryImpl();
    registry.addCoreEmbedTag('card', createLinkCardRenderer({ isLinkCardEnabled: () => false }));
    const cache = storage();
    const url = 'https://example.invalid/toggled-off';
    const tree = embedTree(url);
    await makeEmbedTagDispatch(registry, buildCtx(cache, 'core'), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = cardNodeOf(tree);
    expect(node.value).toBe(renderFallbackCard(url));
    expect(node.data?.crowiLinkCard).toEqual({ url });
  });

  it('fetch failure produces the SAME html and the SAME sidecar shape as toggle-off (indistinguishable, no disabled kind)', async () => {
    const registry = new RendererRegistryImpl();
    // Enabled — but the target is a private address the SSRF guard
    // rejects, so the OGP fetch fails without touching the network.
    registry.addCoreEmbedTag('card', createLinkCardRenderer({ isLinkCardEnabled: () => true }));
    const cache = storage();
    const url = 'http://127.0.0.1:1/unreachable';
    const tree = embedTree(url);
    await makeEmbedTagDispatch(registry, buildCtx(cache, 'core'), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const node = cardNodeOf(tree);
    expect(node.value).toBe(renderFallbackCard(url));
    expect(node.data?.crowiLinkCard).toEqual({ url });
  });
});

describe('bypass path — error renders pair errorPlaceholder html with the structured error placeholder', () => {
  it('an erroring bypass render yields matching html/structured placeholders', async () => {
    const registry = new RendererRegistryImpl();
    const failing: EmbedRenderer = {
      cacheVersion: 1,
      reservation: { variant: 'fixed', heightPx: 48 },
      shouldBypassCache: () => true,
      render: () => ({ html: '', error: { code: 'network', message: 'nope' } }),
    };
    registry.addCoreEmbedTag('failbypass', failing);
    const cache = storage();
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '@' },
            { type: 'link', url: 'https://x.example/y', children: [{ type: 'text', value: 'failbypass' }] },
          ],
        },
      ],
    } as unknown as Root;
    await makeEmbedTagDispatch(registry, buildCtx(cache, 'core'), { cache, pageId: new Types.ObjectId().toHexString() })(tree);
    const paragraph = (tree as unknown as { children: Array<{ children: HtmlNode[] }> }).children[0];
    const node = paragraph.children.find((c) => c.type === 'html');
    expect(node?.value).toContain('crowi-embed-placeholder-error-network');
    expect((node?.data?.crowiPlaceholder as { kind: string }).kind).toBe('error-network');
  });
});
