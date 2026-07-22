import { Types } from 'mongoose';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';
import { createFakeDiagramRenderer, fakeDiagramErrorResult, fakeDiagramReadyResult } from './fake-diagram-code-block';

/**
 * e2e (real pipeline, `code-block-dispatch.ts` + `PluginRenderCache`)
 * coverage for an in-process (no outbound fetch) diagram
 * `CodeBlockRenderer` — the registration/cache/`previewPolicy:
 * 'server-render'` SHAPE `@crowi/plugin-renderer-mermaid` uses.
 * feature-renderer-plugin-boundary Phase 2 (§1/§4) converted this
 * suite off the real plugin package (which forks a child-process
 * render-worker pool) onto `createFakeDiagramRenderer`; the real
 * Mermaid render, sanitization defense-in-depth, and `cacheVersion`
 * bump now live in the plugin's own test suite
 * (`render-engine.test.ts`, `index.test.ts`,
 * `render-worker.dist-boot.test.ts`) plus the reference-runner
 * integration suite (`packages/e2e/tests/renderer-plugins.spec.ts`).
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-fixture-inprocess-diagram';
const LANG = 'fake-inprocess-diagram';

describe('e2e: in-process diagram CodeBlockRenderer (registry/cache/preview contract)', () => {
  let pageId: string;

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const buildRegistryAndCtx = (renderImpl: jest.Mock, previewPolicy?: 'server-render') => {
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl, { previewPolicy }));
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'save',
      log: silentLogger,
      actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    return { reg, storage, ctx };
  };

  it('renders a fence into an html node carrying the new ready data contract', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramReadyResult('<img alt="diagram">'));
    const { reg, ctx, storage } = buildRegistryAndCtx(renderImpl);
    const body = ['```' + LANG, 'flowchart TD', '  A --> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    const html = (top as { value: string }).value;
    expect(html).toContain('data-crowi-renderer-presentation="diagram"');
    expect(html).toContain('data-crowi-renderer-state="ready"');
  });

  it('caches the rendered result and skips render() on a second run with the same body', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramReadyResult('<img alt="diagram">'));
    const { reg, ctx, storage } = buildRegistryAndCtx(renderImpl);
    const body = ['```' + LANG, 'flowchart TD', '  A --> B', '```'].join('\n');
    await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(renderImpl).toHaveBeenCalledTimes(1);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const cachedCountAfterFirst = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(cachedCountAfterFirst).toBe(1);

    // Fresh registry (mirrors a new request), same body + pageId → cache hit.
    renderImpl.mockClear();
    const reg2 = new RendererRegistryImpl();
    makeRendererScope(reg2, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(renderImpl).not.toHaveBeenCalled();
    expect((second.tree.children[0] as { value: string }).value).toContain('data-crowi-renderer-state="ready"');
    const cachedCountAfterSecond = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(cachedCountAfterSecond).toBe(1);
  });

  it('renders the fixed error placeholder for a classification-A render error and caches it with the 5-minute error TTL (not the 1h success default)', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramErrorResult('unknown', 'bad diagram source'));
    const { reg, ctx, storage } = buildRegistryAndCtx(renderImpl);
    const body = ['```' + LANG, 'not a real diagram', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    const top = result.tree.children[0];
    const html = (top as { value: string }).value;
    expect(html).toContain('crowi-embed-placeholder-error-unknown');

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pageId: new Types.ObjectId(pageId) })
      .lean()
      .exec();
    expect(doc).toBeTruthy();
    const ttlMs = (doc?.expiresAt.getTime() ?? 0) - (doc?.fetchedAt.getTime() ?? 0);
    expect(ttlMs).toBe(5 * 60 * 1000);
  });

  it('skips dispatch for unregistered code-block langs', async () => {
    const reg = new RendererRegistryImpl();
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'save',
      log: silentLogger,
      actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    const body = ['```' + LANG, 'flowchart TD', '  A --> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(result.tree.children[0].type).toBe('code');
  });

  // feature-plugin-renderer-mermaid spec §7 — editor preview parity,
  // generalized off the real plugin: a `previewPolicy: 'server-render'`
  // registration renders through the page-less dispatch branch
  // (`pipeline.ts`'s `pageId`-falsy branch → `makePreviewCodeBlockDispatch`)
  // exercised end-to-end via `runPipeline`, and writes nothing to
  // `PluginRenderCache` (`code-block-dispatch.test.ts` covers the
  // dispatch function in isolation with more cases; this proves the
  // full pipeline wiring for a `previewPolicy: 'server-render'`
  // registration).
  it('editor preview parity (spec §7): a previewPolicy:"server-render" fence renders through the page-less dispatch branch with no pageId and writes nothing to PluginRenderCache', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramReadyResult('<img alt="diagram">'));
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl, { previewPolicy: 'server-render' }));
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
    };
    const body = ['```' + LANG, 'flowchart TD', '  A --> B', '```'].join('\n');

    // `pageId: null` mirrors `POST /pages/preview`'s call into `runPipeline`.
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    const html = (top as { value: string }).value;
    expect(html).toContain('<div data-source-line="1">');
    expect(html).toContain('data-crowi-renderer-state="ready"');
    expect(renderImpl).toHaveBeenCalledTimes(1);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    expect(await PluginRenderCache.countDocuments({}).exec()).toBe(0);
  });
});
