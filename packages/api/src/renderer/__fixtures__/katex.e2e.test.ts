import type { PluginContext, PluginLogger, RenderContext } from '@crowi/plugin-api';
import katexPlugin from '@crowi/plugin-renderer-katex';
import { crowi } from 'src/test/setup';
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

const PLUGIN = '@crowi/plugin-renderer-katex';

const stubPluginCtx: PluginContext = {
  config: () => ({}) as never,
  dependencyConfig: () => {
    throw new Error('not used');
  },
  setConfig: async () => undefined,
  pageMetadata: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
  model: () => undefined,
  log: silentLogger,
  actor: { kind: 'system' },
} as PluginContext;

/**
 * Walk a tree and concatenate every `html` node's value. KaTeX node
 * renderers mutate `math` / `inlineMath` to `type='html'`, so the
 * resulting tree carries KaTeX output as html-node values.
 */
function collectHtmlValues(tree: { children?: unknown[] }): string {
  const out: string[] = [];
  type Node = { type?: string; value?: string; children?: unknown[] };
  const stack: Node[] = [tree as Node];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'html' && typeof node.value === 'string') out.push(node.value);
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Node);
    }
  }
  return out.join('|');
}

describe('e2e: @crowi/plugin-renderer-katex', () => {
  it('renders inline math `$x^2$` to an html node with katex inline wrapper', async () => {
    const reg = new RendererRegistryImpl();
    katexPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'Look at $x^2$ inline.';
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const html = collectHtmlValues(result.tree);
    expect(html).toContain('katex-inline');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-display');
  });

  it('renders display math `$$ ... $$` (multi-line) to an html node with katex-display wrapper', async () => {
    const reg = new RendererRegistryImpl();
    katexPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['display:', '', '$$', '\\int_0^1 x\\,dx', '$$', '', 'end.'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const html = collectHtmlValues(result.tree);
    expect(html).toContain('katex-block');
    expect(html).toContain('katex-display');
    expect(html).toContain('class="katex"');
  });

  it('renders both inline and display in the same body', async () => {
    const reg = new RendererRegistryImpl();
    katexPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['inline $a+b$ then display:', '', '$$', 'c \\cdot d', '$$'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const html = collectHtmlValues(result.tree);
    expect(html).toContain('katex-inline');
    expect(html).toContain('katex-block');
  });

  it('survives malformed LaTeX without throwing', async () => {
    const reg = new RendererRegistryImpl();
    katexPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'Bad LaTeX: $\\zzz_$ should not crash.';
    await expect(runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null })).resolves.toBeDefined();
  });
});
