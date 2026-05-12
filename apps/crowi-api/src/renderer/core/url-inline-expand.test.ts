import type { PluginLogger, RenderContext, UrlInlineExpansionRule } from '@crowi/plugin-api';
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

const buildCtx = (storage: ReturnType<typeof createMongoCacheStorage>): RenderContext => ({
  mode: 'view',
  log: silentLogger,
  cache: scopeForPlugin(storage, '@crowi/plugin-test'),
  auth: createAuthContextStub(),
});

describe('core/url-inline-expand', () => {
  let pageId: string;
  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const runWithExpanders = async (body: string, rules: UrlInlineExpansionRule[]) => {
    const reg = new RendererRegistryImpl();
    for (const rule of rules) {
      makeRendererScope(reg, '@crowi/plugin-test', silentLogger).addUrlInlineExpander(rule);
    }
    const storage = createMongoCacheStorage(crowi);
    return runPipeline(body, reg, buildCtx(storage), loadDeps, { cache: storage, pageId });
  };

  it('replaces a bare autolink URL when the first expander returns replaced', async () => {
    const rule: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: /^https:\/\/example\.com\//,
      expand: async () => ({ kind: 'replaced', html: '<div class="card">card</div>' }),
    };
    const md = 'See https://example.com/foo for details.';
    const { tree } = await runWithExpanders(md, [rule]);

    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const html = para.children.find((c) => c.type === 'html');
    expect(html).toBeDefined();
    expect((html as { value: string }).value).toContain('<div class="card">card</div>');
  });

  it('falls through to the next expander when the first returns unchanged', async () => {
    const callOrder: string[] = [];
    const first: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: /^https:\/\/example\.com\//,
      expand: async () => {
        callOrder.push('first');
        return { kind: 'unchanged' };
      },
    };
    const second: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: /^https:\/\/example\.com\//,
      expand: async () => {
        callOrder.push('second');
        return { kind: 'replaced', html: '<x>second</x>' };
      },
    };
    const { tree } = await runWithExpanders('https://example.com/path', [first, second]);

    expect(callOrder).toEqual(['first', 'second']);
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const html = para.children.find((c) => c.type === 'html');
    expect((html as { value: string }).value).toContain('<x>second</x>');
  });

  it('keeps the autolink as-is when every expander returns unchanged', async () => {
    const rule: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: () => true,
      expand: async () => ({ kind: 'unchanged' }),
    };
    const { tree } = await runWithExpanders('https://example.com/foo', [rule]);

    const para = tree.children[0] as { children: Array<{ type: string }> };
    const types = para.children.map((c) => c.type);
    // GFM autolink → a single `link` node remains.
    expect(types).toContain('link');
    expect(types).not.toContain('html');
  });

  it('does not expand inline-link [label](url) when label !== url', async () => {
    const expander = jest.fn(async () => ({ kind: 'replaced' as const, html: '<x/>' }));
    const rule: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: () => true,
      expand: expander,
    };
    await runWithExpanders('See [my link](https://example.com)', [rule]);

    expect(expander).not.toHaveBeenCalled();
  });

  it('only fires for the first matching expander when match function rejects', async () => {
    const callOrder: string[] = [];
    const nope: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: () => false,
      expand: async () => {
        callOrder.push('nope');
        return { kind: 'replaced', html: '<no/>' };
      },
    };
    const yes: UrlInlineExpansionRule = {
      cacheVersion: 1,
      match: () => true,
      expand: async () => {
        callOrder.push('yes');
        return { kind: 'replaced', html: '<yes/>' };
      },
    };
    await runWithExpanders('https://example.com', [nope, yes]);
    expect(callOrder).toEqual(['yes']);
  });
});
