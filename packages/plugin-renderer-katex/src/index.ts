import { createJiti } from 'jiti';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import katex from 'katex';
import type { CrowiPlugin, NodeRenderer } from '@crowi/plugin-api';

/**
 * @crowi/plugin-renderer-katex
 *
 * Parses `$inline$` and `$$display$$` LaTeX via `remark-math`, then
 * renders each math node to HTML via `katex.renderToString` and
 * replaces the node in-place with an `html` node. CSS for the
 * resulting markup ships from `katex/dist/katex.min.css` (web side
 * imports it; the plugin only produces HTML).
 *
 * `remark-math` is ESM-only and loaded via `jiti`. `katex` is dual
 * CJS/ESM and can be statically imported from CJS without jiti.
 *
 * Phase 6 ships vanilla KaTeX standard commands only. Macros /
 * `\newcommand` customisation are Phase 7+.
 */

/**
 * Cached factory closure. Same pattern as `loadRemarkEmoji` /
 * `loadRemarkBreaks` — first call jiti-loads the module, subsequent
 * boots reuse the cached reference. Test-only export.
 */
type RemarkMathFn = (...args: unknown[]) => (...inner: unknown[]) => void;
let remarkMathCache: RemarkMathFn | null = null;

export function loadRemarkMath(): RemarkMathFn {
  if (remarkMathCache !== null) return remarkMathCache;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('remark-math') as { default: RemarkMathFn };
  remarkMathCache = mod.default;
  return remarkMathCache;
}

/**
 * The unified-plugin factory we hand to `registry.addUnifiedPlugin`.
 * unified's `.use(plugin, opts)` calls `plugin.call(processor, opts)`,
 * so we MUST pass the loaded `remark-math` reference directly rather
 * than invoking it ourselves — `remark-math` reads `this.data()` from
 * the unified processor and would crash if invoked detached.
 *
 * The api's `addUnifiedPlugin` path passes `PipelineMetadata` as the
 * second argument; `remark-math` ignores arguments (no options), so
 * the metadata pass-through is harmless.
 */
function remarkMathUnifiedPlugin(this: unknown, ...args: unknown[]): unknown {
  const remarkMath = loadRemarkMath();
  return (remarkMath as (...inner: unknown[]) => unknown).apply(this, args);
}

/**
 * Render KaTeX HTML for a math / inlineMath node, mutating the node
 * in place. The runtime's `runNodeRenderers` (pipeline.ts:287-303)
 * walks every node of the registered type and invokes each renderer;
 * we mutate the node directly because runNodeRenderers does NOT
 * capture return values.
 *
 * Wrapper:
 *   - display math → `<div class="katex-block">…</div>`
 *   - inline math  → `<span class="katex-inline">…</span>`
 *
 * The KaTeX-emitted HTML already contains its own `<span class="katex">`
 * top-level wrapper, so the extra Crowi wrapper provides a stable
 * hook for our own CSS without depending on KaTeX's internal class
 * names.
 *
 * `strict: 'ignore'` + `throwOnError: false` ensure malformed LaTeX
 * never crashes a page render — KaTeX falls back to a red error frame
 * in the output.
 */
function renderMathToHtml(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      strict: 'ignore',
      throwOnError: false,
      output: 'html',
    });
  } catch (err) {
    // strict:'ignore' + throwOnError:false should never escape here,
    // but defence-in-depth: an internal KaTeX assertion would otherwise
    // crash the whole page render.
    const message = err instanceof Error ? err.message : String(err);
    return `<span class="katex-error" title="KaTeX render failed">${escapeHtml(value)}</span><!-- ${escapeHtml(message)} -->`;
  }
}

interface MutableMathNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: unknown[];
}

const renderMathBlock: NodeRenderer = (node, _ctx) => {
  const mathNode = node as MutableMathNode;
  const html = renderMathToHtml(mathNode.value ?? '', true);
  mathNode.type = 'html';
  mathNode.value = `<div class="katex-block">${html}</div>`;
  // Drop any node-renderer-irrelevant fields so downstream serialisers
  // see a clean `html` shape.
  delete mathNode.children;
  delete mathNode.data;
};

const renderMathInline: NodeRenderer = (node, _ctx) => {
  const mathNode = node as MutableMathNode;
  const html = renderMathToHtml(mathNode.value ?? '', false);
  mathNode.type = 'html';
  mathNode.value = `<span class="katex-inline">${html}</span>`;
  delete mathNode.children;
  delete mathNode.data;
};

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-katex',
  version: '0.1.0-dev',
  adminPlacement: {
    section: 'renderer',
    label: 'KaTeX math',
    icon: 'function-square',
  },
  registerRenderer: (registry, ctx) => {
    registry.addUnifiedPlugin(remarkMathUnifiedPlugin, { phase: 'transform' });
    registry.addNodeRenderer('math', renderMathBlock);
    registry.addNodeRenderer('inlineMath', renderMathInline);
    ctx.log.debug('registered remark-math (transform) + katex node renderers (math/inlineMath)');
  },
};

export default plugin;

// Internal renderers exported for unit-tests.
export const _renderers = { renderMathBlock, renderMathInline };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
