import { createJiti } from 'jiti';
import type { Break, Root } from 'mdast';
import type { PluginLogger, RendererRegistry, RenderPhase } from '@crowi/plugin-api';
import crowiLegacyPlugin, { loadRemarkBreaks } from './index';

/**
 * Minimal RendererRegistry capture stub. The real implementation lives
 * in `packages/api/src/renderer/registry.ts`; mirroring its shape here
 * lets us assert that `registerRenderer` queues `remark-breaks` on the
 * transform phase without coupling the plugin unit-test to the api
 * package's TypeScript graph.
 */
interface CapturedRegistration {
  plugin: unknown;
  phase: RenderPhase;
}

function makeRegistry(): { scope: RendererRegistry; captured: CapturedRegistration[] } {
  const captured: CapturedRegistration[] = [];
  const scope: RendererRegistry = {
    addUnifiedPlugin: (plugin, options) => {
      captured.push({ plugin, phase: options?.phase ?? 'transform' });
    },
    addNodeRenderer: () => undefined,
    addCodeBlockRenderer: () => undefined,
    addEmbedTag: () => undefined,
    addUrlInlineExpander: () => undefined,
  };
  return { scope, captured };
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('@crowi/plugin-renderer-crowi-legacy', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(crowiLegacyPlugin.name).toBe('@crowi/plugin-renderer-crowi-legacy');
    expect(crowiLegacyPlugin.version).toBe('0.1.0-dev');
    expect(typeof crowiLegacyPlugin.registerRenderer).toBe('function');
  });

  it('registers exactly one transform-phase unified plugin', () => {
    const { scope, captured } = makeRegistry();
    crowiLegacyPlugin.registerRenderer?.(scope, {
      log: silentLogger,
      // The other PluginContext fields aren't read by registerRenderer.
    } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].phase).toBe('transform');
    // Should reference the loaded remark-breaks module (a function or
    // an object whose default is a function — jiti's `interopDefault`
    // surfaces the default export as the module body).
    expect(captured[0].plugin).toBeDefined();
  });

  it('caches the remark-breaks load across registerRenderer calls', () => {
    const first = loadRemarkBreaks();
    const second = loadRemarkBreaks();
    expect(first).toBe(second);
  });

  it('end-to-end: single-newline body parses + transforms into a tree with a `break` node', () => {
    // Use the same jiti loader the api package's pipeline uses so the
    // ESM-only unified + remark-parse load synchronously under ts-jest.
    const jiti = createJiti(__filename, { interopDefault: true });
    const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
    const remarkParseMod = jiti('remark-parse') as { default: unknown };
    const remarkBreaks = loadRemarkBreaks();

    const processor = unifiedMod
      .unified()
      .use(remarkParseMod.default)
      .use(remarkBreaks as never);
    const tree = processor.parse('line1\nline2');
    const transformed = processor.runSync(tree);

    // remark-breaks rewrites the soft-break between `line1` and `line2`
    // into a `break` node inside the paragraph.
    expect(transformed.type).toBe('root');
    const paragraph = transformed.children[0] as { type: string; children: Array<{ type: string }> };
    expect(paragraph.type).toBe('paragraph');
    const breakNode = paragraph.children.find((c) => c.type === 'break') as Break | undefined;
    expect(breakNode).toBeDefined();
  });

  it('end-to-end: paragraph break (\\n\\n) stays as paragraph boundary, not a break', () => {
    const jiti = createJiti(__filename, { interopDefault: true });
    const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
    const remarkParseMod = jiti('remark-parse') as { default: unknown };
    const remarkBreaks = loadRemarkBreaks();

    const processor = unifiedMod
      .unified()
      .use(remarkParseMod.default)
      .use(remarkBreaks as never);
    const tree = processor.parse('para1\n\npara2');
    const transformed = processor.runSync(tree);

    // \n\n should split into two paragraphs; remark-breaks must NOT
    // collapse that into a single paragraph with a break node.
    expect(transformed.children).toHaveLength(2);
    expect(transformed.children[0].type).toBe('paragraph');
    expect(transformed.children[1].type).toBe('paragraph');
  });

  it('end-to-end: \\n inside a fenced code block is NOT converted to a break', () => {
    const jiti = createJiti(__filename, { interopDefault: true });
    const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
    const remarkParseMod = jiti('remark-parse') as { default: unknown };
    const remarkBreaks = loadRemarkBreaks();

    const processor = unifiedMod
      .unified()
      .use(remarkParseMod.default)
      .use(remarkBreaks as never);
    const tree = processor.parse(['```', 'a', 'b', '```'].join('\n'));
    const transformed = processor.runSync(tree);

    // Fenced code is a leaf `code` node — remark-breaks walks
    // paragraph children only, so it should be untouched.
    expect(transformed.children).toHaveLength(1);
    expect(transformed.children[0].type).toBe('code');
  });
});

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}
