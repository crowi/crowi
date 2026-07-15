import crowiLegacyPlugin from '@crowi/plugin-renderer-crowi-legacy';
import type { Heading, Paragraph } from 'mdast';
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
 * package and run `registerRenderer` against a fresh
 * RendererRegistryImpl, then drive the full pipeline. Phase 5 of
 * RFC-0002 narrowed this plugin's scope: the remark-breaks
 * (single-newline → `<br>`) behaviour moved into the core pipeline as
 * a Crowi-wide default, and what remains here are *actual* v1
 * idiosyncrasies — currently just the `##hoge` heading-without-space
 * normaliser.
 *
 * No Mongo dependency — the v1-heading-fix transform is pure AST
 * mutation and doesn't hit `cache` / `auth`, so we skip `dispatch`
 * and the `crowi` test harness entirely.
 */
describe('e2e: @crowi/plugin-renderer-crowi-legacy (v1 quirks)', () => {
  const enablePlugin = (reg: RendererRegistryImpl) => {
    const scope = makeRendererScope(reg, PLUGIN, silentLogger);
    crowiLegacyPlugin.registerRenderer?.(scope, {
      log: silentLogger,
      actor: { kind: 'system' },
      // Other PluginContext fields aren't read by registerRenderer.
    } as never);
  };

  it('rewrites `##hoge` (no-space ATX heading) into a real heading depth 2 when the plugin is active', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { tree } = await runPipeline('##hoge', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(1);
    const heading = tree.children[0] as Heading;
    expect(heading.type).toBe('heading');
    expect(heading.depth).toBe(2);
    expect(heading.children[0]).toEqual({ type: 'text', value: 'hoge' });
  });

  it('without the plugin: `##hoge` stays a paragraph (control)', async () => {
    const reg = new RendererRegistryImpl();
    // Intentionally do NOT register the plugin — only the bundled
    // core 4 transforms (+ core remark-breaks) run.
    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { tree } = await runPipeline('##hoge', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe('paragraph');
  });

  it('splits `##hoge\\nbar` into heading + leftover paragraph (leading `<br>` from core breaks gets stripped)', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    // Core remark-breaks runs before the plugin, so the paragraph
    // arriving at the plugin is [text("##hoge"), break, text("bar")].
    // The plugin must produce: heading "hoge" + paragraph "bar".
    const { tree } = await runPipeline('##hoge\nbar', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(2);
    expect((tree.children[0] as Heading).type).toBe('heading');
    expect((tree.children[0] as Heading).depth).toBe(2);
    const leftover = tree.children[1] as Paragraph;
    expect(leftover.type).toBe('paragraph');
    expect(leftover.children[0]).toEqual({ type: 'text', value: 'bar' });
  });

  it('coexists with bundled core transforms — proper `# Title` headings still get TOC entries', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const body = ['# Title', '', '##sub', '', 'See [[/foo]]'].join('\n');
    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { metadata } = await runPipeline(body, reg, ctx, loadDeps);

    // Proper `# Title` (with space) goes through the core headings
    // transform and lands in the TOC. The plugin-rewritten `##sub`
    // does NOT — that limitation is documented in the README because
    // the core headings transform runs before the registry plugin.
    expect(metadata.toc.map((e) => e.text)).toEqual(['Title']);
    expect(metadata.toc[0].anchorId).toBe('title');

    // Wikilinks still extracted by the core wikilinks transform.
    expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/foo']);
  });
});
