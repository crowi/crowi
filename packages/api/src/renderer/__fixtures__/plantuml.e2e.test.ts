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
 * coverage for a fetch-backed diagram `CodeBlockRenderer` — the
 * registration/cache/stale-if-error SHAPE `@crowi/plugin-renderer-
 * plantuml` uses. feature-renderer-plugin-boundary Phase 2 (§1/§4)
 * converted this suite off the real plugin package onto
 * `createFakeDiagramRenderer` (an injectable `render()`, same
 * `RenderResult` success/error contract); the real PlantUML server
 * round-trip, SVG sanitization, and `cacheVersion` bump now live in
 * the plugin's own `index.test.ts` + the reference-runner integration
 * suite (`packages/e2e/tests/renderer-plugins.spec.ts`).
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-fixture-diagram';
const LANG = 'fake-diagram';

describe('e2e: fetch-backed diagram CodeBlockRenderer (registry/cache/stale-if-error contract)', () => {
  let pageId: string;

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  it('renders a fence into an html node carrying the new ready data contract', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramReadyResult('<svg><path d="M0 0"/></svg>'));
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```' + LANG, 'A -> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    expect(renderImpl).toHaveBeenCalledTimes(1);
    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    const html = (top as { value: string }).value;
    expect(html).toContain('data-crowi-renderer-presentation="diagram"');
    expect(html).toContain('data-crowi-renderer-state="ready"');
    expect(html).toContain('<svg');
  });

  it('caches the result and skips render() on a second run with the same body', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramReadyResult('<svg><path d="M0 0"/></svg>'));
    const reg1 = new RendererRegistryImpl();
    makeRendererScope(reg1, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```' + LANG, 'A -> B', '```'].join('\n');
    await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(renderImpl).toHaveBeenCalledTimes(1);

    // Second run — fresh registry, same body + pageId → cache hit.
    renderImpl.mockClear();
    const reg2 = new RendererRegistryImpl();
    makeRendererScope(reg2, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(renderImpl).not.toHaveBeenCalled();
    expect(second.tree.children[0].type).toBe('html');
    expect((second.tree.children[0] as { value: string }).value).toContain('fake-diagram-embed');
  });

  it('renders an error placeholder when render() rejects with a network-style error', async () => {
    const renderImpl = jest.fn().mockResolvedValue(fakeDiagramErrorResult('network', 'ECONNREFUSED'));
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```' + LANG, 'A -> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    expect((top as { value: string }).value).toContain('crowi-embed-placeholder-error-network');
  });

  it('keeps serving the last-good diagram (stale-if-error) instead of dropping to a placeholder when a revalidation fails', async () => {
    const renderImpl = jest.fn().mockResolvedValueOnce(fakeDiagramReadyResult('<svg><path d="M0 0"/></svg>'));
    const reg1 = new RendererRegistryImpl();
    makeRendererScope(reg1, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```' + LANG, 'A -> B', '```'].join('\n');
    await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(renderImpl).toHaveBeenCalledTimes(1);

    // Force the cached entry well past its stale window (fresh TTL is 1h,
    // so 5h back safely clears the 4x stale-multiplier window too) — the
    // NEXT read blocks on a re-render rather than serving fresh,
    // exercising the blocking stale-if-error path.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await PluginRenderCache.updateOne({ pluginName: PLUGIN, pageId: new Types.ObjectId(pageId) }, { $set: { expiresAt: past } }).exec();

    // Simulate the server going down mid-restart (spec's motivating case).
    renderImpl.mockClear();
    renderImpl.mockResolvedValueOnce(fakeDiagramErrorResult('network', 'ECONNREFUSED'));
    const reg2 = new RendererRegistryImpl();
    makeRendererScope(reg2, PLUGIN, silentLogger).addCodeBlockRenderer(LANG, createFakeDiagramRenderer(renderImpl));
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });

    expect(renderImpl).toHaveBeenCalledTimes(1); // revalidation was attempted…
    const top = second.tree.children[0];
    expect(top.type).toBe('html');
    // …but the diagram stays on screen instead of degrading to a placeholder.
    expect((top as { value: string }).value).toContain('<svg');
    expect((top as { value: string }).value).not.toContain('crowi-embed-placeholder-error');
  });

  it('skips dispatch for unregistered code-block langs', async () => {
    // No renderer registered → no render() call, code node passes through.
    const reg = new RendererRegistryImpl();
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    const body = ['```' + LANG, 'A -> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(result.tree.children[0].type).toBe('code');
  });
});
