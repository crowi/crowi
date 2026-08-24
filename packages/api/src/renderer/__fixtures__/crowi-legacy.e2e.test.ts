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

  // feature-renderer-break-normalization D-5 — `core/break-normalization.ts`
  // now runs before the registry's external transforms too, so a bare
  // `<br>` right after a v1 `##heading` is a canonical `break` node by the
  // time this plugin's leading-break skip (`v1HeadingReplacement`'s
  // `restChildren.length === 0 && child.type === 'break'` check) sees it —
  // where it used to be `html` and survive as spurious leading content.
  // These 3 shapes are only reachable through the REAL pipeline (the
  // plugin's own hand-built unit test at `index.test.ts` passes the same
  // `[text, break, text]` tree before AND after this feature, so it cannot
  // observe the difference); pinning here is the only gate on this
  // cross-feature interaction.
  it('drops a leading `break` (from a normalized `<br>`) after `##hoge` — same result as `##hoge\\nbar`', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { tree } = await runPipeline('##hoge<br>bar', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(2);
    expect((tree.children[0] as Heading).type).toBe('heading');
    expect((tree.children[0] as Heading).depth).toBe(2);
    const leftover = tree.children[1] as Paragraph;
    expect(leftover.type).toBe('paragraph');
    // `toMatchObject`, not `toEqual`: unlike the synthetic `text` node
    // `remarkBreaks` builds for the `##hoge\nbar` case above, this "bar"
    // is the ORIGINAL text node straight from `remark-parse`'s inline
    // tokenizer (the split here comes from the `<br>` tag, not a
    // newline), so it still carries a real `position`.
    expect(leftover.children).toHaveLength(1);
    expect(leftover.children[0]).toMatchObject({ type: 'text', value: 'bar' });
  });

  it('drops the entire trailing paragraph when `##hoge<br>` has nothing after the normalized break', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { tree } = await runPipeline('##hoge<br>', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as Heading).type).toBe('heading');
    expect((tree.children[0] as Heading).depth).toBe(2);
  });

  it('drops BOTH leading breaks when `##hoge<br><br>text` normalizes to two consecutive `break` nodes', async () => {
    const reg = new RendererRegistryImpl();
    enablePlugin(reg);

    const ctx: RenderContext = { mode: 'save', log: silentLogger, actor: { kind: 'system' } };
    const { tree } = await runPipeline('##hoge<br><br>text', reg, ctx, loadDeps);

    expect(tree.children).toHaveLength(2);
    expect((tree.children[0] as Heading).type).toBe('heading');
    const leftover = tree.children[1] as Paragraph;
    expect(leftover.type).toBe('paragraph');
    expect(leftover.children).toHaveLength(1);
    expect(leftover.children[0]).toMatchObject({ type: 'text', value: 'text' });
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
