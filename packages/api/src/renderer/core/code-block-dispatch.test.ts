import type { CodeBlockRenderer, PluginLogger, RenderContext } from '@crowi/plugin-api';
import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';

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
