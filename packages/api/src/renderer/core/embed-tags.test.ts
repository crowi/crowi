import type { EmbedRenderer, PluginLogger, RenderContext } from '@crowi/plugin-api';
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

const buildCtx = (storage: ReturnType<typeof createMongoCacheStorage>, pluginName: string): RenderContext => ({
  mode: 'view',
  log: silentLogger,
  actor: { kind: 'system' },
  cache: scopeForPlugin(storage, pluginName),
  auth: createAuthContextStub(),
});

const buildEchoRenderer = (): EmbedRenderer => ({
  cacheVersion: 1,
  render: async (input) => ({ html: `<div class="echo">${input.url}</div>` }),
});

describe('core/embed-tags @[tag](url) parser', () => {
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
    const ctx = buildCtx(storage, '@crowi/plugin-echo');
    return runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
  };

  it('replaces registered @[tag](url) with the rendered html', async () => {
    const { tree } = await runWithRegistry('See @[echo](hello) here.', (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', buildEchoRenderer());
    });

    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    expect(para.children.map((c) => c.type)).toEqual(['text', 'html', 'text']);
    expect((para.children[1] as { value: string }).value).toContain('<div class="echo">hello</div>');
  });

  it('leaves unregistered tags as their natural mdast shape (text+link+text)', async () => {
    // The RFC says "未 registered tag → plain text fallback". In
    // practice CommonMark parses `@[unknown](xyz)` as `@` + an inline
    // `[unknown](xyz)` link before our transform sees it; the plain-
    // text fallback means we simply don't rewrite the triple. The
    // user-visible result is `@` followed by a regular link, which
    // is the most graceful fallback we can produce without forking
    // remark-parse.
    const { tree } = await runWithRegistry('See @[unknown](xyz) here.', () => undefined);
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const types = para.children.map((c) => c.type);
    expect(types).toEqual(['text', 'link', 'text']);
    expect(types.includes('html')).toBe(false);
    // The leading `@` is preserved verbatim (not stripped — only the
    // matched-and-rewritten path drops the `@`).
    expect((para.children[0] as { value: string }).value).toBe('See @');
  });

  it('skips matches inside fenced code blocks', async () => {
    const renderer = buildEchoRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = ['```', '@[echo](inside)', '```', '', 'Outside @[echo](kept).'].join('\n');
    const { tree } = await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0].url).toBe('kept');

    // Code block is preserved as-is.
    const codeNode = tree.children.find((c) => c.type === 'code');
    expect(codeNode).toMatchObject({ type: 'code', value: '@[echo](inside)' });
  });

  it('skips matches inside inline code', async () => {
    const renderer = buildEchoRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = 'Quoted `@[echo](skip)` text and live @[echo](kept) here.';
    await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0].url).toBe('kept');
  });

  it('handles multiple matches in one paragraph', async () => {
    const renderer = buildEchoRenderer();
    const { tree } = await runWithRegistry('@[echo](one) and @[echo](two) and end.', (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });

    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const htmlNodes = para.children.filter((c) => c.type === 'html');
    expect(htmlNodes).toHaveLength(2);
    expect(htmlNodes[0].value).toContain('one');
    expect(htmlNodes[1].value).toContain('two');
  });

  it('coexists with GFM autolink (renderer not double-fired for <https://x>)', async () => {
    const renderer = buildEchoRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = '<https://example.com> and @[echo](side).';
    await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0].url).toBe('side');
  });

  it('coexists with inline link [label](url) — only @[tag](url) matches', async () => {
    const renderer = buildEchoRenderer();
    const renderSpy = jest.spyOn(renderer, 'render');
    const md = 'See [label](https://example.com) and @[echo](next).';
    await runWithRegistry(md, (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0].url).toBe('next');
  });

  it('survives mentions adjacent to embed tags', async () => {
    const renderer = buildEchoRenderer();
    const { metadata } = await runWithRegistry('hi @alice see @[echo](deck).', (reg) => {
      makeRendererScope(reg, '@crowi/plugin-echo', silentLogger).addEmbedTag('echo', renderer);
    });
    expect(metadata.mentions).toEqual([{ username: 'alice' }]);
  });
});
