import type { NodeRenderer, PluginLogger, RenderContext, RendererRegistry, RenderPhase } from '@crowi/plugin-api';
import { createJiti } from 'jiti';
import type { Root } from 'mdast';
import katexPlugin, { _renderers, loadRemarkMath } from './index';

/**
 * Minimal RendererRegistry capture stub. Captures unified-plugin
 * registrations + node-renderer registrations so we can assert the
 * exact shape `registerRenderer` produces.
 */
interface CapturedUnified {
  plugin: unknown;
  phase: RenderPhase;
}
interface CapturedNodeRenderer {
  type: string;
  renderer: NodeRenderer;
}

function makeRegistry(): { scope: RendererRegistry; unifiedCaptured: CapturedUnified[]; nodeCaptured: CapturedNodeRenderer[] } {
  const unifiedCaptured: CapturedUnified[] = [];
  const nodeCaptured: CapturedNodeRenderer[] = [];
  const scope: RendererRegistry = {
    addUnifiedPlugin: (plugin, options) => {
      unifiedCaptured.push({ plugin, phase: options?.phase ?? 'transform' });
    },
    addNodeRenderer: (type, renderer) => {
      nodeCaptured.push({ type, renderer });
    },
    addCodeBlockRenderer: () => undefined,
    addEmbedTag: () => undefined,
    addUrlInlineExpander: () => undefined,
  };
  return { scope, unifiedCaptured, nodeCaptured };
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * `actor` became a required `RenderContext` field in
 * feature-plugin-renderer-mermaid Phase 1 (spec §6, admission
 * control) — KaTeX never reads it (it declares no
 * `admissionControl`), so a fixed `'system'` actor is fine here.
 */
const stubCtx: RenderContext = {
  mode: 'view',
  actor: { kind: 'system' },
  log: silentLogger,
};

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

/**
 * Build a unified+remark-parse processor with remark-math applied so
 * the e2e tests can walk the parsed tree and confirm math /
 * inlineMath nodes appear before the node renderers run.
 */
function buildMathProcessor(): UnifiedProcessor {
  const jiti = createJiti(__filename, { interopDefault: true });
  const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
  const remarkParseMod = jiti('remark-parse') as { default: unknown };
  const remarkMath = loadRemarkMath();
  return unifiedMod
    .unified()
    .use(remarkParseMod.default)
    .use(remarkMath as never);
}

interface MathNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: unknown[];
}

describe('@crowi/plugin-renderer-katex', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(katexPlugin.name).toBe('@crowi/plugin-renderer-katex');
    expect(katexPlugin.version).toBe('0.1.0-dev');
    expect(typeof katexPlugin.registerRenderer).toBe('function');
  });

  it('registers exactly 1 unified plugin (transform) and 2 node renderers (math + inlineMath)', () => {
    const { scope, unifiedCaptured, nodeCaptured } = makeRegistry();
    katexPlugin.registerRenderer?.(scope, { log: silentLogger } as never);

    expect(unifiedCaptured).toHaveLength(1);
    expect(unifiedCaptured[0].phase).toBe('transform');

    expect(nodeCaptured).toHaveLength(2);
    expect(nodeCaptured.map((c) => c.type).sort()).toEqual(['inlineMath', 'math']);
  });

  it('caches the remark-math load across loadRemarkMath calls', () => {
    const first = loadRemarkMath();
    const second = loadRemarkMath();
    expect(first).toBe(second);
  });

  it('end-to-end: `$x^2$` parses to an inlineMath mdast node', () => {
    const processor = buildMathProcessor();
    const tree = processor.runSync(processor.parse('see $x^2$ inline')) as {
      children: Array<{ type: string; children?: Array<{ type: string; value?: string }> }>;
    };
    // The paragraph children are [text, inlineMath, text].
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const inline = para.children.find((c) => c.type === 'inlineMath');
    expect(inline).toBeDefined();
    expect(inline?.value).toBe('x^2');
  });

  it('end-to-end: multi-line `$$ ... $$` parses to a top-level math mdast node', () => {
    const processor = buildMathProcessor();
    // remark-math only emits the block-level `math` type when the
    // delimiters are on their own lines; an inline `$$...$$` stays
    // `inlineMath` (CommonMark phrasing default).
    const md = ['display', '', '$$', '\\int_0^1 x\\,dx', '$$', '', 'end'].join('\n');
    const tree = processor.runSync(processor.parse(md)) as { children: Array<{ type: string; value?: string }> };
    const mathNode = tree.children.find((c) => c.type === 'math');
    expect(mathNode).toBeDefined();
    expect(mathNode?.value).toContain('\\int');
  });

  it('renderMathBlock mutates a math node to type=html with katex-block wrapper + displayMode HTML', () => {
    const node: MathNode = { type: 'math', value: '\\int_0^1 x' };
    _renderers.renderMathBlock(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.value).toContain('katex-block');
    // KaTeX displayMode emits `<span class="katex-display"><span class="katex">…`.
    expect(node.value).toContain('katex-display');
    expect(node.value).toContain('class="katex"');
  });

  it('renderMathInline mutates an inlineMath node to type=html with katex-inline wrapper + non-display HTML', () => {
    const node: MathNode = { type: 'inlineMath', value: 'x^2' };
    _renderers.renderMathInline(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.value).toContain('katex-inline');
    expect(node.value).toContain('class="katex"');
    // Non-display mode → no katex-display wrapper.
    expect(node.value).not.toContain('katex-display');
  });

  it('drops children + data from a node after mutating to html (clean shape downstream)', () => {
    const node: MathNode = {
      type: 'math',
      value: 'a',
      data: { foo: 'bar' },
      children: [{ irrelevant: true }],
    };
    _renderers.renderMathBlock(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.data).toBeUndefined();
    expect(node.children).toBeUndefined();
  });

  it('malformed LaTeX does NOT throw — strict:ignore + throwOnError:false renders an error frame', () => {
    const node: MathNode = { type: 'inlineMath', value: '\\zzz' };
    expect(() => _renderers.renderMathInline(node, stubCtx)).not.toThrow();
    expect(node.type).toBe('html');
    expect(typeof node.value).toBe('string');
    expect((node.value as string).length).toBeGreaterThan(0);
  });

  it('renderMathBlock returns nothing (renders via mutation only)', () => {
    const node: MathNode = { type: 'math', value: 'a' };
    const result = _renderers.renderMathBlock(node, stubCtx);
    // The NodeRenderer contract returns void | Promise<void> — we
    // assert the function returns undefined explicitly so the
    // mutation contract is the only effect channel.
    expect(result).toBeUndefined();
  });
});
