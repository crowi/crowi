import crowiLegacyPlugin from '@crowi/plugin-renderer-crowi-legacy';
import type { Break, Paragraph, Root } from 'mdast';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, makeRendererScope } from '../registry';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-renderer-crowi-legacy';

/**
 * e2e: load the actual `@crowi/plugin-renderer-crowi-legacy` workspace
 * package, run `registerRenderer` against a fresh RendererRegistryImpl,
 * then run the full Phase 2 pipeline. Mirrors the echo-embed e2e test
 * but exercises the plugin's `remark-breaks` transform.
 *
 * No Mongo dependency — the breaks transform is pure AST mutation and
 * doesn't hit `cache` / `auth`, so we skip `dispatch` and the `crowi`
 * test harness entirely.
 */
describe('e2e: @crowi/plugin-renderer-crowi-legacy (Phase 5)', () => {
  it('single-newline body produces a `break` node when the plugin is active', async () => {
    const reg = new RendererRegistryImpl();
    const scope = makeRendererScope(reg, PLUGIN, silentLogger);
    crowiLegacyPlugin.registerRenderer?.(scope, {
      log: silentLogger,
      // The other PluginContext fields aren't read by registerRenderer.
    } as never);

    const ctx: RenderContext = { mode: 'save', log: silentLogger };
    const { tree } = await runPipeline('line1\nline2', reg, ctx, loadDeps);

    expect(tree.type).toBe('root');
    const para = tree.children[0] as Paragraph;
    expect(para.type).toBe('paragraph');
    const breakNode = para.children.find((c): c is Break => c.type === 'break');
    expect(breakNode).toBeDefined();
  });

  it('without the plugin: single-newline body has NO `break` node (control)', async () => {
    const reg = new RendererRegistryImpl();
    // Intentionally do NOT register crowi-legacy here; just run the
    // bundled core 4 transforms.
    const ctx: RenderContext = { mode: 'save', log: silentLogger };
    const { tree } = await runPipeline('line1\nline2', reg, ctx, loadDeps);

    const para = tree.children[0] as Paragraph;
    expect(para.type).toBe('paragraph');
    const breakNode = para.children.find((c): c is Break => c.type === 'break');
    expect(breakNode).toBeUndefined();
  });

  it('plugin coexists with bundled core transforms — headings and wikilinks still resolve', async () => {
    const reg = new RendererRegistryImpl();
    const scope = makeRendererScope(reg, PLUGIN, silentLogger);
    crowiLegacyPlugin.registerRenderer?.(scope, { log: silentLogger } as never);

    const body = ['# Title', '', 'See [[/foo]]', 'and second line.'].join('\n');
    const ctx: RenderContext = { mode: 'save', log: silentLogger };
    const { tree, metadata } = await runPipeline(body, reg, ctx, loadDeps);

    // Core: heading anchor still computed.
    expect(metadata.toc.map((e) => e.text)).toEqual(['Title']);
    expect(metadata.toc[0].anchorId).toBe('title');
    // Core: wikilink still extracted.
    expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/foo']);

    // Plugin: paragraph with `\n` between `See [[/foo]]` and `and
    // second line.` has a `break` node.
    const paragraph = (tree as Root).children.find((c) => c.type === 'paragraph') as Paragraph | undefined;
    expect(paragraph).toBeDefined();
    const breakNode = paragraph?.children.find((c): c is Break => c.type === 'break');
    expect(breakNode).toBeDefined();
  });

  it('plugin does NOT split a paragraph break (\\n\\n) into a break node', async () => {
    const reg = new RendererRegistryImpl();
    const scope = makeRendererScope(reg, PLUGIN, silentLogger);
    crowiLegacyPlugin.registerRenderer?.(scope, { log: silentLogger } as never);

    const ctx: RenderContext = { mode: 'save', log: silentLogger };
    const { tree } = await runPipeline('para1\n\npara2', reg, ctx, loadDeps);

    // Two distinct paragraphs, no break nodes inside either.
    expect(tree.children).toHaveLength(2);
    for (const child of tree.children) {
      expect(child.type).toBe('paragraph');
      const para = child as Paragraph;
      expect(para.children.find((c) => c.type === 'break')).toBeUndefined();
    }
  });
});
