import type { CodeBlockRenderer, PluginLogger, RenderContext } from '@crowi/plugin-api';
import type { Code, Root } from 'mdast';
import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';
import { MAX_ADMISSION_DISPATCH_COUNT, makeCodeBlockDispatch } from './code-block-dispatch';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-fixture-codeblock';

/**
 * Build a CodeBlockRenderer that records every render call and emits a
 * deterministic html wrapper around the source. Default cacheVersion=1.
 */
const buildEchoCodeBlockRenderer = (overrides?: Partial<CodeBlockRenderer>): CodeBlockRenderer => ({
  cacheVersion: 1,
  render: (info) => ({ html: `<div data-lang="${info.lang}">${info.source}</div>` }),
  ...overrides,
});

const buildCtx = (storage: ReturnType<typeof createMongoCacheStorage>, pluginName: string): RenderContext => ({
  mode: 'view',
  log: silentLogger,
  actor: { kind: 'system' },
  cache: scopeForPlugin(storage, pluginName),
  auth: createAuthContextStub(),
});

describe('core/code-block-dispatch', () => {
  let pageId: string;
  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const runWithRegistry = async (body: string, configureRegistry: (reg: RendererRegistryImpl) => void) => {
    const reg = new RendererRegistryImpl();
    configureRegistry(reg);
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage, PLUGIN);
    return { result: await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId }), storage };
  };

  it('replaces a top-level ```fake-lang code block with the rendered html', async () => {
    const renderer = buildEchoCodeBlockRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = ['```fake-lang', 'A -> B', '```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0]).toEqual({ lang: 'fake-lang', source: 'A -> B' });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    expect((top as { value: string }).value).toBe('<div data-lang="fake-lang">A -> B</div>');
  });

  it('leaves unregistered lang fences untouched (web-side fallback)', async () => {
    const md = ['```fake-lang', 'A -> B', '```'].join('\n');
    const { result } = await runWithRegistry(md, () => undefined);
    const top = result.tree.children[0];
    expect(top.type).toBe('code');
    expect((top as { lang?: string; value?: string }).lang).toBe('fake-lang');
  });

  it('rewrites fences nested inside a blockquote', async () => {
    const renderer = buildEchoCodeBlockRenderer();
    const md = ['> outer quote', '>', '> ```fake-lang', '> A', '> ```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });

    const blockquote = result.tree.children[0] as { type: string; children: Array<{ type: string; value?: string }> };
    expect(blockquote.type).toBe('blockquote');
    const html = blockquote.children.find((c) => c.type === 'html');
    expect(html).toMatchObject({ type: 'html', value: expect.stringContaining('data-lang="fake-lang"') });
  });

  it('rewrites fences nested inside a list item', async () => {
    const renderer = buildEchoCodeBlockRenderer();
    const md = ['- item with code', '', '    ```fake-lang', '    payload', '    ```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });

    const list = result.tree.children[0] as { type: string; children: Array<{ children: Array<{ type: string }> }> };
    expect(list.type).toBe('list');
    const listItem = list.children[0];
    const html = listItem.children.find((c) => c.type === 'html');
    expect(html).toMatchObject({ type: 'html', value: expect.stringContaining('data-lang="fake-lang"') });
  });

  it('caches the render output and skips re-invocation on the second run', async () => {
    const renderer = buildEchoCodeBlockRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = ['```fake-lang', 'A -> B', '```'].join('\n');

    const { result: first, storage } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect((first.tree.children[0] as { value: string }).value).toContain('A -> B');

    // Second run with the same body — render() must NOT fire again.
    renderSpy.mockClear();
    const reg2 = new RendererRegistryImpl();
    makeRendererScope(reg2, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    const ctx2 = buildCtx(storage, PLUGIN);
    const second = await runPipeline(md, reg2, ctx2, loadDeps, { cache: storage, pageId });
    expect(renderSpy).not.toHaveBeenCalled();
    expect((second.tree.children[0] as { value: string }).value).toContain('A -> B');
  });

  it('rewrites multiple fences in the same parent in source order', async () => {
    const renderer = buildEchoCodeBlockRenderer();
    const md = ['```fake-lang', 'first', '```', '', '```fake-lang', 'second', '```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });

    const children = result.tree.children;
    expect(children).toHaveLength(2);
    expect(children[0].type).toBe('html');
    expect(children[1].type).toBe('html');
    expect((children[0] as { value: string }).value).toContain('first');
    expect((children[1] as { value: string }).value).toContain('second');
  });

  it('falls through unregistered langs even when other langs are registered', async () => {
    const fakeRenderer = buildEchoCodeBlockRenderer();
    const md = ['```fake-lang', 'A', '```', '', '```other-lang', 'B', '```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', fakeRenderer);
    });
    expect(result.tree.children[0].type).toBe('html');
    expect(result.tree.children[1].type).toBe('code');
  });

  it('routes RenderError responses through the error placeholder', async () => {
    const renderer: CodeBlockRenderer = {
      cacheVersion: 1,
      render: () => ({ html: '', error: { code: 'network', message: 'simulated' } }),
    };
    const md = ['```fake-lang', 'A', '```'].join('\n');
    const { result } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });
    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    // The error placeholder carries a stable class for the network code.
    expect((top as { value: string }).value).toContain('crowi-embed-placeholder-error-network');
  });

  it('honours a plugin-provided computeEmbedKey override', async () => {
    const computeSpy = jest.fn().mockReturnValue('fixed-key');
    const renderer: CodeBlockRenderer = {
      cacheVersion: 1,
      computeEmbedKey: computeSpy,
      render: (info) => ({ html: `<x>${info.source}</x>` }),
    };
    const md = ['```fake-lang', 'A', '```'].join('\n');
    await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
    });
    expect(computeSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy.mock.calls[0][0]).toEqual({ lang: 'fake-lang', source: 'A' });
  });

  it('skips dispatch entirely when no code-block renderers are registered', async () => {
    const md = ['```fake-lang', 'A', '```'].join('\n');
    const { result } = await runWithRegistry(md, () => undefined);
    // No renderer registered → code node survives.
    expect(result.tree.children[0].type).toBe('code');
  });
});

describe('core/code-block-dispatch — classification C (feature-plugin-renderer-mermaid §5/§6 dispatch-count cap)', () => {
  let pageId: string;
  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const ADMISSION_CONFIG = { maxConcurrentGlobal: 100, maxConcurrentPerUser: 100, queueDepth: 1000 };

  const buildAdmissionRenderer = (renderSpy: jest.Mock): CodeBlockRenderer => ({
    cacheVersion: 1,
    admissionControl: ADMISSION_CONFIG,
    render: (info) => {
      renderSpy(info);
      return { html: `<div data-lang="${info.lang}">${info.source}</div>`, ttlSec: 3600 };
    },
  });

  /** N fenced `admission-lang` code nodes; `targetIndex` (0-based) gets `targetSource`, the rest get unique filler sources. */
  const buildTree = (count: number, targetIndex: number, targetSource: string): Root => ({
    type: 'root',
    children: Array.from(
      { length: count },
      (_, i): Code => ({
        type: 'code',
        lang: 'admission-lang',
        value: i === targetIndex ? targetSource : `filler-${i}`,
      }),
    ),
  });

  const dispatchTree = async (tree: Root, reg: RendererRegistryImpl, targetPageId: string) => {
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage, PLUGIN);
    await makeCodeBlockDispatch(reg, ctx, { cache: storage, pageId: targetPageId })(tree);
    return { tree, storage };
  };

  it('the (N+1)th admission-gated candidate gets the fixed limit placeholder without calling render() or writing to the cache', async () => {
    const renderSpy = jest.fn();
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('admission-lang', buildAdmissionRenderer(renderSpy));

    // MAX_ADMISSION_DISPATCH_COUNT (50) within-limit fillers + 1 over-limit target at index 50 (the 51st).
    const tree = buildTree(MAX_ADMISSION_DISPATCH_COUNT + 1, MAX_ADMISSION_DISPATCH_COUNT, 'TARGET SOURCE');
    await dispatchTree(tree, reg, pageId);

    const overLimitNode = tree.children[MAX_ADMISSION_DISPATCH_COUNT] as unknown as { type: string; value?: string };
    // Not replaced with real rendered HTML, and not left as the raw `code` node either — always resolved somehow.
    expect(renderSpy).not.toHaveBeenCalledWith({ lang: 'admission-lang', source: 'TARGET SOURCE' });
    expect(overLimitNode.type).toBe('html');
    expect((overLimitNode as { value: string }).value).toContain('crowi-embed-placeholder-error-dispatch-limit');
    expect((overLimitNode as { value: string }).value).not.toContain('TARGET SOURCE');

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const count = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    // Only the 50 within-limit fillers wrote cache entries — the 51st never touched the cache.
    expect(count).toBe(MAX_ADMISSION_DISPATCH_COUNT);
  });

  it('cross-page isolation: the same source succeeding at position 10 on one page and exceeding the limit at position 51 on another do not corrupt each other’s cache entry', async () => {
    const renderSpy = jest.fn();
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('admission-lang', buildAdmissionRenderer(renderSpy));
    const SHARED_SOURCE = 'shared diagram source';

    const pageAId = new Types.ObjectId().toHexString();
    const pageBId = new Types.ObjectId().toHexString();

    // Page A: the shared source at position 10 (well within the limit) — succeeds and caches.
    const treeA = buildTree(10, 9, SHARED_SOURCE);
    await dispatchTree(treeA, reg, pageAId);
    const nodeA = treeA.children[9] as unknown as { type: string; value?: string };
    expect(nodeA.type).toBe('html');
    expect((nodeA as { value: string }).value).toContain(SHARED_SOURCE);

    // Page B: the SAME source, but as the 51st admission-gated candidate — exceeds the limit.
    const treeB = buildTree(MAX_ADMISSION_DISPATCH_COUNT + 1, MAX_ADMISSION_DISPATCH_COUNT, SHARED_SOURCE);
    await dispatchTree(treeB, reg, pageBId);
    const nodeB = treeB.children[MAX_ADMISSION_DISPATCH_COUNT] as unknown as { type: string; value?: string };
    expect((nodeB as { value: string }).value).toContain('crowi-embed-placeholder-error-dispatch-limit');

    // Page A's cache entry (keyed on pageId + content-hash embedKey) must still be the real
    // rendered result — Page B's over-limit dispatch (same source, same embedKey) must not
    // have touched it, and vice versa: Page B must not have picked up Page A's cached entry
    // (they're isolated by pageId in the compound cache key regardless).
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    // Page A has 10 total candidates, all within the limit — all 10 cache.
    const pageADocs = await PluginRenderCache.find({ pageId: new Types.ObjectId(pageAId) })
      .lean()
      .exec();
    expect(pageADocs).toHaveLength(10);
    const pageASharedDoc = pageADocs.find((d) => d.html.includes(SHARED_SOURCE));
    expect(pageASharedDoc).toBeDefined();
    expect(pageASharedDoc?.html).toBe(`<div data-lang="admission-lang">${SHARED_SOURCE}</div>`);
    // Page B had 50 within-limit fillers cached + 0 for the over-limit 51st
    // (which shares the SAME content-hash embedKey as Page A's entry above
    // — proving the two pages' rows never collided/overwrote each other).
    const pageBDocs = await PluginRenderCache.find({ pageId: new Types.ObjectId(pageBId) })
      .lean()
      .exec();
    expect(pageBDocs).toHaveLength(MAX_ADMISSION_DISPATCH_COUNT);
    expect(pageBDocs.some((d) => d.html.includes(SHARED_SOURCE))).toBe(false);
  });

  it('same-page cache pollution guard: the same source succeeding at position 10 and exceeding the limit at position 60 on ONE page must not corrupt (overwrite or duplicate) the position-10 cache entry', async () => {
    const renderSpy = jest.fn();
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('admission-lang', buildAdmissionRenderer(renderSpy));
    const SHARED_SOURCE = 'shared diagram source (same page, two positions)';

    // 60 admission-gated candidates on a SINGLE page: the shared source
    // repeats at position 10 (index 9, well within the 50-candidate
    // limit) and again at position 60 (index 59, the 60th candidate —
    // past the limit). Every other position gets a unique filler so no
    // OTHER embedKey collides.
    const tree: Root = {
      type: 'root',
      children: Array.from(
        { length: 60 },
        (_, i): Code => ({
          type: 'code',
          lang: 'admission-lang',
          value: i === 9 || i === 59 ? SHARED_SOURCE : `filler-${i}`,
        }),
      ),
    };

    await dispatchTree(tree, reg, pageId);

    const nodeAt10 = tree.children[9] as unknown as { type: string; value?: string };
    const nodeAt60 = tree.children[59] as unknown as { type: string; value?: string };

    // Position 10 renders for real (well within the limit) and caches.
    expect(nodeAt10.type).toBe('html');
    expect((nodeAt10 as { value: string }).value).toBe(`<div data-lang="admission-lang">${SHARED_SOURCE}</div>`);

    // Position 60 (60th admission-gated candidate on this SAME page)
    // gets the fixed limit placeholder — even though it shares the exact
    // same (pageId, embedKey) cache key as position 10's already-cached
    // entry.
    expect(nodeAt60.type).toBe('html');
    expect((nodeAt60 as { value: string }).value).toContain('crowi-embed-placeholder-error-dispatch-limit');
    expect((nodeAt60 as { value: string }).value).not.toContain(SHARED_SOURCE);

    // render() was invoked for the shared source exactly once (position
    // 10) — position 60 never reached the renderer, `cachedRender`, or
    // `acquireRenderSlot` at all.
    expect(renderSpy.mock.calls.filter((call) => (call[0] as { source: string }).source === SHARED_SOURCE)).toHaveLength(1);

    // Cache pollution check: exactly ONE row exists for (pageId,
    // SHARED_SOURCE's embedKey), and it is still position 10's real
    // rendered HTML — position 60's over-limit dispatch neither
    // overwrote it with a placeholder nor created a second, competing
    // row for the same key.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const sharedDocs = await PluginRenderCache.find({
      pageId: new Types.ObjectId(pageId),
      html: `<div data-lang="admission-lang">${SHARED_SOURCE}</div>`,
    })
      .lean()
      .exec();
    expect(sharedDocs).toHaveLength(1);

    // Total cache rows: only the 50 within-limit candidates (indices
    // 0-49, including the shared source at index 9) wrote cache entries
    // — the 10 over-limit candidates (indices 50-59, including the
    // shared source's repeat at index 59) never touched the cache.
    const totalCount = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(totalCount).toBe(MAX_ADMISSION_DISPATCH_COUNT);
  });
});
