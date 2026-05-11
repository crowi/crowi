import type { PluginContext, PluginLogger, RenderContext } from '@crowi/plugin-api';
import emojiPlugin from '@crowi/plugin-renderer-emoji';
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

const PLUGIN = '@crowi/plugin-renderer-emoji';

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
  crypto: { encrypt: (s) => s, decrypt: (s) => s },
  log: silentLogger,
} as PluginContext;

/**
 * Walk a tree and concatenate every `text` node's value. Lets the test
 * assert "the resulting visible text contains 😄" without dancing
 * around paragraph / inline structure.
 */
function collectTextValues(tree: { children?: unknown[] }): string {
  const out: string[] = [];
  type Node = { type?: string; value?: string; children?: unknown[] };
  const stack: Node[] = [tree as Node];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'text' && typeof node.value === 'string') out.push(node.value);
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Node);
    }
  }
  return out.join('');
}

describe('e2e: @crowi/plugin-renderer-emoji', () => {
  it('replaces `:smile:` with the unicode emoji in the rendered tree', async () => {
    const reg = new RendererRegistryImpl();
    emojiPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'Hi :smile:!';
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const text = collectTextValues(result.tree);
    expect(text).toContain('😄');
    expect(text).not.toContain(':smile:');
  });

  it('preserves `:smile:` inside a fenced code block', async () => {
    const reg = new RendererRegistryImpl();
    emojiPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), stubPluginCtx);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```', ':smile: should stay verbatim', '```', '', 'Outside :smile: replaced.'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    // The code block is a leaf with the raw value.
    type CodeNode = { type: string; value?: string };
    const codeNode = (result.tree.children as CodeNode[]).find((c) => c.type === 'code');
    expect(codeNode?.value).toContain(':smile: should stay verbatim');

    // The outside paragraph has had its `:smile:` substituted.
    const text = collectTextValues(result.tree);
    expect(text).toContain('😄');
  });
});
