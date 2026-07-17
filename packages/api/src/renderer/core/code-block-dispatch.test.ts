import type { AdmissionControlConfig, CodeBlockInfo, CodeBlockRenderer, PluginLogger, RenderContext } from '@crowi/plugin-api';
import type { Code, Root } from 'mdast';
import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';
import * as renderAdmission from './render-admission';
import {
  MAX_ADMISSION_DISPATCH_COUNT,
  bindPreviewPluginName,
  makeCodeBlockDispatch,
  makePreviewCodeBlockDispatch,
  renderCodeBlockForPreview,
} from './code-block-dispatch';

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

/** Poll the event loop until `predicate()` is true or `maxTicks` is exhausted. */
const waitUntil = async (predicate: () => boolean, maxTicks = 200): Promise<void> => {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
};

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

  it('a registration with NO admissionControl (PlantUML-shaped) is dispatched via plain cachedRender on the page-bound save path — acquireRenderSlot is never called (spec §5 AC 3)', async () => {
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    try {
      const renderer = buildEchoCodeBlockRenderer(); // no `admissionControl` field
      const renderSpy = jest.spyOn(renderer, 'render');
      const md = ['```fake-lang', 'A -> B', '```'].join('\n');
      const { result } = await runWithRegistry(md, (reg) => {
        makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('fake-lang', renderer);
      });

      expect(renderSpy).toHaveBeenCalledTimes(1); // rendered via plain cachedRender, not skipped
      expect((result.tree.children[0] as { value: string }).value).toBe('<div data-lang="fake-lang">A -> B</div>');
      expect(acquireSpy).not.toHaveBeenCalled();
    } finally {
      acquireSpy.mockRestore();
    }
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

  it('the cap counts a previewPolicy:"server-render" registration even when it declares NO admissionControl (§7 item 7 — cap must not be admissionControl-only)', async () => {
    // A hypothetical future server-render registration that opts out of
    // the admission-queue gate entirely (no `admissionControl`) still
    // MUST be bounded by the 50-diagram dispatch cap — `renderCodeBlockForPreview`
    // would call `cb.render()` directly with no admission gate for such a
    // registration (see its doc comment), so the dispatch cap is the
    // ONLY thing bounding it. On the save path this same registration
    // goes through plain `cachedRender` (no `admissionControl` ⇒ no
    // `cachedRenderOrPending` routing, spec §5) — proving the cap fires
    // here too, independent of that separate routing decision.
    const renderSpy = jest.fn();
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-no-admission-lang', {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      render: (info) => {
        renderSpy(info);
        return { html: `<div data-lang="${info.lang}">${info.source}</div>`, ttlSec: 3600 };
      },
    });
    const tree: Root = {
      type: 'root',
      children: Array.from(
        { length: MAX_ADMISSION_DISPATCH_COUNT + 1 },
        (_, i): Code => ({ type: 'code', lang: 'preview-no-admission-lang', value: i === MAX_ADMISSION_DISPATCH_COUNT ? 'TARGET SOURCE' : `filler-${i}` }),
      ),
    };

    await dispatchTree(tree, reg, pageId);

    const overLimitNode = tree.children[MAX_ADMISSION_DISPATCH_COUNT] as unknown as { type: string; value?: string };
    expect(overLimitNode.type).toBe('html');
    expect((overLimitNode as { value: string }).value).toContain('crowi-embed-placeholder-error-dispatch-limit');
    expect((overLimitNode as { value: string }).value).not.toContain('TARGET SOURCE');
    expect(renderSpy).not.toHaveBeenCalledWith({ lang: 'preview-no-admission-lang', source: 'TARGET SOURCE' });
    expect(renderSpy).toHaveBeenCalledTimes(MAX_ADMISSION_DISPATCH_COUNT);
  });
});

describe('core/code-block-dispatch — makePreviewCodeBlockDispatch (feature-plugin-renderer-mermaid spec §7)', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const GENEROUS_ADMISSION: AdmissionControlConfig = { maxConcurrentGlobal: 100, maxConcurrentPerUser: 100, queueDepth: 1000 };

  const buildServerRenderRenderer = (overrides?: Partial<CodeBlockRenderer>): CodeBlockRenderer => ({
    cacheVersion: 1,
    previewPolicy: 'server-render',
    admissionControl: GENEROUS_ADMISSION,
    render: (info) => ({ html: `<div data-lang="${info.lang}">${info.source}</div>`, ttlSec: 3600 }),
    ...overrides,
  });

  const dispatchPreview = async (tree: Root, reg: RendererRegistryImpl) => {
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage, PLUGIN);
    await makePreviewCodeBlockDispatch(reg, ctx, { cache: storage })(tree);
    return { tree, storage };
  };

  const buildUserCtx = (storage: ReturnType<typeof createMongoCacheStorage>, userId: string): RenderContext => ({
    mode: 'view',
    log: silentLogger,
    actor: { kind: 'user', userId },
    cache: scopeForPlugin(storage, PLUGIN),
    auth: createAuthContextStub(),
  });

  it('server-renders a previewPolicy:"server-render" candidate through renderCodeBlockForPreview and never writes to PluginRenderCache', async () => {
    const renderSpy = jest.fn((info: { lang: string; source: string }) => ({ html: `<div data-lang="${info.lang}">${info.source}</div>` }));
    const renderer: CodeBlockRenderer = { cacheVersion: 1, previewPolicy: 'server-render', render: renderSpy };
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-lang', renderer);
    // A real remark-parse `position` so `startLine` (and therefore the
    // data-source-line wrap) is exercised the way production candidates
    // always have it.
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'code',
          lang: 'preview-lang',
          value: 'A -> B',
          position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 3, column: 4, offset: 20 } },
        } as Code,
      ],
    };

    await dispatchPreview(tree, reg);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    const top = tree.children[0] as unknown as { type: string; value: string };
    expect(top.type).toBe('html');
    expect(top.value).toBe('<div data-source-line="1"><div data-lang="preview-lang">A -> B</div></div>');

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    expect(await PluginRenderCache.countDocuments({}).exec()).toBe(0);
  });

  it('leaves a default-policy (previewPolicy omitted, PlantUML-shaped) candidate untouched — render() is never called with no pageId', async () => {
    const renderSpy = jest.fn(() => ({ html: '<div>should never appear in preview</div>' }));
    const renderer: CodeBlockRenderer = { cacheVersion: 1, render: renderSpy };
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('default-policy-lang', renderer);
    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'default-policy-lang', value: '@startuml\nA -> B\n@enduml' } as Code] };

    await dispatchPreview(tree, reg);

    expect(renderSpy).not.toHaveBeenCalled();
    const top = tree.children[0] as unknown as { type: string; lang?: string };
    expect(top.type).toBe('code');
    expect(top.lang).toBe('default-policy-lang');
  });

  it('resolves multiple server-render diagrams in the same page-less tree, in source order', async () => {
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-lang', buildServerRenderRenderer());
    const tree: Root = {
      type: 'root',
      children: [{ type: 'code', lang: 'preview-lang', value: 'first' } as Code, { type: 'code', lang: 'preview-lang', value: 'second' } as Code],
    };

    await dispatchPreview(tree, reg);

    expect((tree.children[0] as unknown as { type: string; value: string }).type).toBe('html');
    expect((tree.children[0] as unknown as { value: string }).value).toContain('first');
    expect((tree.children[1] as unknown as { type: string; value: string }).type).toBe('html');
    expect((tree.children[1] as unknown as { value: string }).value).toContain('second');
  });

  it('the (N+1)th server-render candidate hits the fixed classification-C dispatch-limit placeholder without calling render() or acquireRenderSlot', async () => {
    const renderSpy = jest.fn();
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer(
      'preview-lang',
      buildServerRenderRenderer({
        render: (info) => {
          renderSpy(info);
          return { html: `<div>${info.source}</div>`, ttlSec: 3600 };
        },
      }),
    );
    const tree: Root = {
      type: 'root',
      children: Array.from(
        { length: MAX_ADMISSION_DISPATCH_COUNT + 1 },
        (_, i): Code => ({ type: 'code', lang: 'preview-lang', value: i === MAX_ADMISSION_DISPATCH_COUNT ? 'TARGET SOURCE' : `filler-${i}` }),
      ),
    };

    try {
      await dispatchPreview(tree, reg);

      const overLimitNode = tree.children[MAX_ADMISSION_DISPATCH_COUNT] as unknown as { type: string; value: string };
      expect(overLimitNode.type).toBe('html');
      expect(overLimitNode.value).toContain('crowi-embed-placeholder-error-dispatch-limit');
      expect(overLimitNode.value).not.toContain('TARGET SOURCE');
      expect(renderSpy).not.toHaveBeenCalledWith({ lang: 'preview-lang', source: 'TARGET SOURCE' });
      // Exactly the 50 within-limit candidates acquired a slot — the
      // 51st never reached `acquireRenderSlot` at all.
      expect(acquireSpy).toHaveBeenCalledTimes(MAX_ADMISSION_DISPATCH_COUNT);
    } finally {
      acquireSpy.mockRestore();
    }
  });

  it('the cap applies uniformly on the preview path too for a previewPolicy:"server-render" registration with NO admissionControl (§7 item 7)', async () => {
    // Companion to the save-path version of this test (classification C
    // describe block above) — proves the SAME collectCandidates cap
    // fires on the page-less preview dispatch for a registration that
    // has no admission gate at all, so `renderCodeBlockForPreview` would
    // otherwise call `cb.render()` unboundedly for every candidate.
    const renderSpy = jest.fn();
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-no-admission-lang', {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      render: (info) => {
        renderSpy(info);
        return { html: `<div>${info.source}</div>`, ttlSec: 3600 };
      },
    });
    const tree: Root = {
      type: 'root',
      children: Array.from(
        { length: MAX_ADMISSION_DISPATCH_COUNT + 1 },
        (_, i): Code => ({ type: 'code', lang: 'preview-no-admission-lang', value: i === MAX_ADMISSION_DISPATCH_COUNT ? 'TARGET SOURCE' : `filler-${i}` }),
      ),
    };

    await dispatchPreview(tree, reg);

    const overLimitNode = tree.children[MAX_ADMISSION_DISPATCH_COUNT] as unknown as { type: string; value: string };
    expect(overLimitNode.type).toBe('html');
    expect(overLimitNode.value).toContain('crowi-embed-placeholder-error-dispatch-limit');
    expect(overLimitNode.value).not.toContain('TARGET SOURCE');
    expect(renderSpy).not.toHaveBeenCalledWith({ lang: 'preview-no-admission-lang', source: 'TARGET SOURCE' });
    expect(renderSpy).toHaveBeenCalledTimes(MAX_ADMISSION_DISPATCH_COUNT);
  });

  it('this shares the SAME admission pool the save path uses — acquires with priority:"low" and pluginName === registration.plugin', async () => {
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-lang', buildServerRenderRenderer());
    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-lang', value: 'A' } as Code] };

    try {
      await dispatchPreview(tree, reg);

      expect(acquireSpy).toHaveBeenCalledTimes(1);
      expect(acquireSpy.mock.calls[0][0]).toMatchObject({ pluginName: PLUGIN, priority: 'low' });
    } finally {
      acquireSpy.mockRestore();
    }
  });

  it('error normalisation parity: a thrown render() produces the SAME placeholder html preview-side as the page-bound cachedRender path does', async () => {
    const reservation = { variant: 'aspect' as const, aspectRatio: 1 };
    const throwingRenderer: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      reservation,
      render: () => {
        throw new Error('engine init failed');
      },
    };

    const regSave = new RendererRegistryImpl();
    makeRendererScope(regSave, PLUGIN, silentLogger).addCodeBlockRenderer('preview-error-throw-lang', throwingRenderer);
    const saveTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-error-throw-lang', value: 'X' } as Code] };
    const saveStorage = createMongoCacheStorage(crowi);
    await makeCodeBlockDispatch(regSave, buildCtx(saveStorage, PLUGIN), { cache: saveStorage, pageId: new Types.ObjectId().toHexString() })(saveTree);
    const saveHtml = (saveTree.children[0] as unknown as { value: string }).value;

    const regPreview = new RendererRegistryImpl();
    makeRendererScope(regPreview, PLUGIN, silentLogger).addCodeBlockRenderer('preview-error-throw-lang', throwingRenderer);
    const previewTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-error-throw-lang', value: 'X' } as Code] };
    await dispatchPreview(previewTree, regPreview);
    const previewHtml = (previewTree.children[0] as unknown as { value: string }).value;

    expect(previewHtml).toContain('crowi-embed-placeholder-error-unknown');
    expect(previewHtml).toBe(saveHtml);
  });

  it('error normalisation parity: a returned RenderResult.error produces the SAME placeholder html preview-side as the page-bound cachedRender path does', async () => {
    const reservation = { variant: 'fixed' as const, heightPx: 100 };
    const erroringRenderer: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      reservation,
      render: () => ({ html: '', error: { code: 'network' as const, message: 'simulated upstream failure' } }),
    };

    const regSave = new RendererRegistryImpl();
    makeRendererScope(regSave, PLUGIN, silentLogger).addCodeBlockRenderer('preview-error-result-lang', erroringRenderer);
    const saveTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-error-result-lang', value: 'Y' } as Code] };
    const saveStorage = createMongoCacheStorage(crowi);
    await makeCodeBlockDispatch(regSave, buildCtx(saveStorage, PLUGIN), { cache: saveStorage, pageId: new Types.ObjectId().toHexString() })(saveTree);
    const saveHtml = (saveTree.children[0] as unknown as { value: string }).value;

    const regPreview = new RendererRegistryImpl();
    makeRendererScope(regPreview, PLUGIN, silentLogger).addCodeBlockRenderer('preview-error-result-lang', erroringRenderer);
    const previewTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-error-result-lang', value: 'Y' } as Code] };
    await dispatchPreview(previewTree, regPreview);
    const previewHtml = (previewTree.children[0] as unknown as { value: string }).value;

    expect(previewHtml).toContain('crowi-embed-placeholder-error-network');
    expect(previewHtml).toBe(saveHtml);
  });

  it('admission integration: a save-path (priority:"high") candidate is granted before an earlier-queued preview-path (priority:"low") candidate sharing the same admission pool (spec §6/§8 — verified through the dispatch layer, not render-admission.ts in isolation)', async () => {
    renderAdmission._resetAllPoolsForTest();
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 100, queueDepth: 5 };
    const order: string[] = [];
    let releaseOccupier: (() => void) | undefined;

    const reg = new RendererRegistryImpl();
    const scope = makeRendererScope(reg, PLUGIN, silentLogger);
    // Occupies the pool's single global slot so both candidates below
    // queue up behind it instead of racing for an immediate grant —
    // otherwise arrival order, not priority, would decide who goes first.
    scope.addCodeBlockRenderer('occupier-lang', {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: () =>
        new Promise((resolve) => {
          releaseOccupier = () => resolve({ html: '<div>occupier</div>' });
        }),
    });
    scope.addCodeBlockRenderer('preview-lang', {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: (info) => {
        order.push('preview');
        return { html: `<div>${info.source}</div>` };
      },
    });
    scope.addCodeBlockRenderer('save-lang', {
      cacheVersion: 1,
      admissionControl: TIGHT,
      render: (info) => {
        order.push('save');
        return { html: `<div>${info.source}</div>`, ttlSec: 3600 };
      },
    });

    const occupierTree: Root = { type: 'root', children: [{ type: 'code', lang: 'occupier-lang', value: 'o' } as Code] };
    const occupierPromise = dispatchPreview(occupierTree, reg);
    await waitUntil(() => releaseOccupier !== undefined); // occupier now holds the only slot.

    // Queue the LOW-priority (preview) candidate FIRST…
    const previewTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-lang', value: 'p' } as Code] };
    const previewPromise = dispatchPreview(previewTree, reg);
    await waitUntil(() => renderAdmission._getQueueLengthForTest(PLUGIN) === 1);

    // …then the HIGH-priority (save) candidate SECOND.
    const saveStorage = createMongoCacheStorage(crowi);
    const saveTree: Root = { type: 'root', children: [{ type: 'code', lang: 'save-lang', value: 's' } as Code] };
    const savePromise = makeCodeBlockDispatch(reg, buildCtx(saveStorage, PLUGIN), { cache: saveStorage, pageId: new Types.ObjectId().toHexString() })(saveTree);
    await waitUntil(() => renderAdmission._getQueueLengthForTest(PLUGIN) === 2);

    releaseOccupier?.();
    await Promise.all([occupierPromise, previewPromise, savePromise]);

    // Despite the preview candidate having queued FIRST, the save
    // candidate (priority:'high') is granted before it once a slot frees
    // up — proving priority threads correctly end-to-end through
    // `makeCodeBlockDispatch` / `makePreviewCodeBlockDispatch`, not just
    // `acquireRenderSlot` called directly.
    expect(order).toEqual(['save', 'preview']);
  });

  it("admission integration: the per-user concurrency cap applies through the preview dispatch path, keyed on ctx.actor.userId — a second candidate from the SAME user queues while a DIFFERENT user's candidate is unaffected (spec §6/§8)", async () => {
    renderAdmission._resetAllPoolsForTest();
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 10, maxConcurrentPerUser: 1, queueDepth: 5 };
    const renderSpy = jest.fn();
    let releaseUserAFirst: (() => void) | undefined;

    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('preview-lang', {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: (info) => {
        renderSpy(info.source);
        if (info.source === 'userA-first') {
          return new Promise((resolve) => {
            releaseUserAFirst = () => resolve({ html: '<div>a1</div>' });
          });
        }
        return { html: `<div>${info.source}</div>` };
      },
    });

    const userATree1: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-lang', value: 'userA-first' } as Code] };
    const userAPromise1 = makePreviewCodeBlockDispatch(reg, buildUserCtx(createMongoCacheStorage(crowi), 'user-a'), { cache: createMongoCacheStorage(crowi) })(
      userATree1,
    );
    await waitUntil(() => renderSpy.mock.calls.length === 1); // user-a's first candidate now holds their 1-slot quota.

    // user-a's SECOND candidate must queue (same user, per-user cap=1) — render() must not fire for it yet.
    const userATree2: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-lang', value: 'userA-second' } as Code] };
    const userAPromise2 = makePreviewCodeBlockDispatch(reg, buildUserCtx(createMongoCacheStorage(crowi), 'user-a'), { cache: createMongoCacheStorage(crowi) })(
      userATree2,
    );
    await waitUntil(() => renderAdmission._getQueueLengthForTest(PLUGIN) === 1);
    expect(renderSpy).not.toHaveBeenCalledWith('userA-second');

    // user-b's candidate is a DIFFERENT user — not blocked by user-a's saturation (global capacity is free).
    const userBTree: Root = { type: 'root', children: [{ type: 'code', lang: 'preview-lang', value: 'userB-first' } as Code] };
    await makePreviewCodeBlockDispatch(reg, buildUserCtx(createMongoCacheStorage(crowi), 'user-b'), { cache: createMongoCacheStorage(crowi) })(userBTree);
    expect(renderSpy).toHaveBeenCalledWith('userB-first');

    releaseUserAFirst?.();
    await Promise.all([userAPromise1, userAPromise2]);
    expect(renderSpy).toHaveBeenCalledWith('userA-second');
  });
});

/**
 * Unit tests for `renderCodeBlockForPreview` itself (spec §7 item 5,
 * feature-plugin-renderer-mermaid Phase 2) — the lower-level building
 * block `makePreviewCodeBlockDispatch` (above) calls per candidate.
 * Never touches Mongo — the whole point of this helper is that it
 * doesn't. Lives alongside `makePreviewCodeBlockDispatch` in this file
 * (not `cache/index.test.ts`) because the function itself now lives in
 * `code-block-dispatch.ts` (spec AC 4 — `renderCodeBlockForPreview` is a
 * `code-block-dispatch.ts` export, not a `cache/index.ts` one).
 */
describe('renderCodeBlockForPreview', () => {
  beforeEach(() => {
    renderAdmission._resetAllPoolsForTest();
  });

  /** Generous enough that a single job in a test never has to wait. */
  const GENEROUS_ADMISSION: AdmissionControlConfig = { maxConcurrentGlobal: 4, maxConcurrentPerUser: 4, queueDepth: 50 };

  const previewCodeInfo: CodeBlockInfo = { lang: 'preview-fixture', source: 'A -> B' };
  const buildPreviewCtx = (overrides: Partial<RenderContext> = {}): RenderContext => ({
    mode: 'view',
    log: silentLogger,
    actor: { kind: 'user', userId: 'u-1' },
    ...overrides,
  });

  it('a successful render is returned verbatim (no wrap) when startLine is undefined', async () => {
    const cb: CodeBlockRenderer = { cacheVersion: 1, previewPolicy: 'server-render', render: () => ({ html: '<div>ok</div>' }) };
    const html = await renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined);
    expect(html).toBe('<div>ok</div>');
  });

  it('wraps the resolved html in <div data-source-line="N"> when startLine is a number', async () => {
    const cb: CodeBlockRenderer = { cacheVersion: 1, previewPolicy: 'server-render', render: () => ({ html: '<div>ok</div>' }) };
    const html = await renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), 7);
    expect(html).toBe('<div data-source-line="7"><div>ok</div></div>');
  });

  it('a thrown render() normalises to the SAME `unknown`-code errorPlaceholder cachedRender would have produced, and does not throw', async () => {
    const reservation = { variant: 'aspect' as const, aspectRatio: 1 };
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      reservation,
      render: () => {
        throw new Error('child-process crash');
      },
    };
    const html = await renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined);
    expect(html).toContain('crowi-embed-placeholder-error-unknown');
  });

  it('a returned RenderResult.error normalises to the matching errorPlaceholder', async () => {
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      render: () => ({ html: '', error: { code: 'timeout' as const } }),
    };
    const html = await renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined);
    expect(html).toContain('crowi-embed-placeholder-error-timeout');
  });

  it('throws when cb.admissionControl is set but no pluginName was bound (bindPreviewPluginName was skipped — caller bug, not a runtime condition to guess through)', async () => {
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: GENEROUS_ADMISSION,
      render: () => ({ html: '<div>ok</div>' }),
    };
    await expect(renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined)).rejects.toThrow(/bindPreviewPluginName/);
  });

  it('acquires an admission ticket (priority: "low") when cb.admissionControl is declared, keyed on the bound pluginName', async () => {
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: GENEROUS_ADMISSION,
      render: () => ({ html: '<div>ok</div>' }),
    };
    bindPreviewPluginName(cb, 'p-preview-admission');
    const ctx = buildPreviewCtx();

    try {
      const html = await renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
      expect(html).toBe('<div>ok</div>');
      expect(acquireSpy).toHaveBeenCalledTimes(1);
      expect(acquireSpy.mock.calls[0][0]).toMatchObject({ pluginName: 'p-preview-admission', priority: 'low', actor: ctx.actor });
    } finally {
      acquireSpy.mockRestore();
    }
  });

  it('releases the admission ticket after a SUCCESSFUL render — a second call for the same (tight, capacity-1) pool is granted immediately rather than queued', async () => {
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 5 };
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: () => ({ html: '<div>ok</div>' }),
    };
    bindPreviewPluginName(cb, 'p-preview-release-success');
    const ctx = buildPreviewCtx();

    const firstHtml = await renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    expect(firstHtml).toBe('<div>ok</div>');

    // If the first ticket had NOT been released, `acquireRenderSlot` would
    // push this second call into the wait queue (capacity=1, still held)
    // instead of granting it synchronously — assert the queue BEFORE
    // awaiting, since a queued call would otherwise hang forever (nothing
    // left to drain it).
    const secondPromise = renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    expect(renderAdmission._getQueueLengthForTest('p-preview-release-success')).toBe(0);
    const secondHtml = await secondPromise;
    expect(secondHtml).toBe('<div>ok</div>');
  });

  it('releases the admission ticket after a THROWN render() (exception path) — a second call for the same (tight, capacity-1) pool is granted immediately rather than queued', async () => {
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 5 };
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: () => {
        throw new Error('child-process crash');
      },
    };
    bindPreviewPluginName(cb, 'p-preview-release-exception');
    const ctx = buildPreviewCtx();

    const firstHtml = await renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    expect(firstHtml).toContain('crowi-embed-placeholder-error-unknown');

    // Same non-queued-immediate-grant assertion as the success-path test
    // above, proving `finally { ticket?.release() }` runs on the
    // exception path too (not just the success path it already covered).
    const secondPromise = renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    expect(renderAdmission._getQueueLengthForTest('p-preview-release-exception')).toBe(0);
    const secondHtml = await secondPromise;
    expect(secondHtml).toContain('crowi-embed-placeholder-error-unknown');
  });

  it('never calls render() and returns the unknown-code placeholder when the admission queue is exhausted', async () => {
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 0 };
    let releaseFirst: (() => void) | undefined;
    const renderSpy = jest.fn();
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: () => {
        renderSpy();
        return new Promise<{ html: string }>((resolve) => {
          releaseFirst = () => resolve({ html: '<div>first</div>' });
        });
      },
    };
    bindPreviewPluginName(cb, 'p-preview-overflow');
    const ctx = buildPreviewCtx();

    const firstPromise = renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    await waitUntil(() => renderSpy.mock.calls.length === 1); // first job now holds the only slot.

    const secondHtml = await renderCodeBlockForPreview(cb, previewCodeInfo, ctx, undefined);
    expect(secondHtml).toContain('crowi-embed-placeholder-error-unknown');
    expect(renderSpy).toHaveBeenCalledTimes(1); // the overflowed second call never reached render().

    releaseFirst?.();
    const firstHtml = await firstPromise;
    expect(firstHtml).toBe('<div>first</div>');
  });

  it('a ctx.signal aborted while queued never calls render() and returns the unknown-code placeholder', async () => {
    const TIGHT: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 5 };
    let releaseFirst: (() => void) | undefined;
    const renderSpy = jest.fn();
    const cb: CodeBlockRenderer = {
      cacheVersion: 1,
      previewPolicy: 'server-render',
      admissionControl: TIGHT,
      render: () => {
        renderSpy();
        return new Promise<{ html: string }>((resolve) => {
          releaseFirst = () => resolve({ html: '<div>first</div>' });
        });
      },
    };
    bindPreviewPluginName(cb, 'p-preview-abort');
    const firstPromise = renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined);
    await waitUntil(() => renderSpy.mock.calls.length === 1); // first job holds the only slot.

    const controller = new AbortController();
    const secondPromise = renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx({ signal: controller.signal }), undefined);
    await waitUntil(() => renderAdmission._getQueueLengthForTest('p-preview-abort') === 1);
    controller.abort();

    const secondHtml = await secondPromise;
    expect(secondHtml).toContain('crowi-embed-placeholder-error-unknown');
    expect(renderSpy).toHaveBeenCalledTimes(1); // the aborted-while-queued call never reached render().

    releaseFirst?.();
    await firstPromise;
  });

  it("does not gate render() at all when cb.admissionControl is absent (default policy plugins keep today's no-admission behaviour)", async () => {
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const cb: CodeBlockRenderer = { cacheVersion: 1, render: () => ({ html: '<div>ok</div>' }) };
    try {
      const html = await renderCodeBlockForPreview(cb, previewCodeInfo, buildPreviewCtx(), undefined);
      expect(html).toBe('<div>ok</div>');
      expect(acquireSpy).not.toHaveBeenCalled();
    } finally {
      acquireSpy.mockRestore();
    }
  });
});
