import { Types } from 'mongoose';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';
import { ECHO_TAG, echoEmbedRenderer } from './echo-embed';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-fixture-echo';

describe('e2e: fixture echo-embed plugin (Phase 4)', () => {
  let pageId: string;
  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  it('parse → cache miss → render → cache set → re-parse hits cache', async () => {
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addEmbedTag(ECHO_TAG, echoEmbedRenderer);
    const renderSpy = jest.spyOn(echoEmbedRenderer, 'render');
    renderSpy.mockClear();

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'before @[echo](payload-1) after';

    // First run — cache miss, render() fires once.
    const first = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    const para1 = first.tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const html1 = para1.children.find((c) => c.type === 'html');
    expect((html1 as { value: string }).value).toBe('<div class="echo">payload-1</div>');

    // Cache should now hold exactly one entry.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const stored = await PluginRenderCache.find({ pageId: new Types.ObjectId(pageId), pluginName: PLUGIN })
      .lean()
      .exec();
    expect(stored).toHaveLength(1);
    expect(stored[0].html).toBe('<div class="echo">payload-1</div>');
    expect(stored[0].pluginCacheVersion).toBe(echoEmbedRenderer.cacheVersion);

    // Second run with the same body — render() must NOT fire again.
    renderSpy.mockClear();
    const second = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(renderSpy).not.toHaveBeenCalled();

    const para2 = second.tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const html2 = para2.children.find((c) => c.type === 'html');
    expect((html2 as { value: string }).value).toBe('<div class="echo">payload-1</div>');

    // Still exactly one entry (upsert idempotent).
    const stored2 = await PluginRenderCache.find({ pageId: new Types.ObjectId(pageId), pluginName: PLUGIN })
      .lean()
      .exec();
    expect(stored2).toHaveLength(1);
  });

  it('different payload writes a separate cache entry', async () => {
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addEmbedTag(ECHO_TAG, echoEmbedRenderer);
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    await runPipeline('@[echo](one) @[echo](two)', reg, ctx, loadDeps, { cache: storage, pageId });

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const stored = await PluginRenderCache.find({ pageId: new Types.ObjectId(pageId), pluginName: PLUGIN })
      .lean()
      .exec();
    expect(stored).toHaveLength(2);
    const htmls = stored.map((s) => s.html).sort();
    expect(htmls).toEqual(['<div class="echo">one</div>', '<div class="echo">two</div>']);
  });
});
