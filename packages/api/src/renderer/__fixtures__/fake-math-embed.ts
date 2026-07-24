/**
 * Test-only fixture standing in for `@crowi/plugin-renderer-katex`'s
 * registration SHAPE: `addUnifiedPlugin({ phase: 'transform' })`
 * introduces a custom mdast node type while walking the parsed tree,
 * and `addNodeRenderer` mutates that node type into a clean `html`
 * node. Exercises the exact SAME two registry/pipeline extension
 * points a parse+render optional plugin (KaTeX, and any future
 * syntax-extending renderer) combines, without depending on the real
 * `remark-math` / `katex` packages (feature-renderer-plugin-boundary
 * Phase 2 §1/§4 — API-core generic-registry coverage of an optional
 * plugin's registration mechanics moves to local fakes; the real
 * KaTeX production seam moves to
 * `packages/e2e/tests/renderer-plugins.spec.ts`).
 *
 * Syntax: `{{fm:VALUE}}` inline text → a `fakeMath` mdast node →
 * `<span class="fake-math">VALUE</span>` html node. Deliberately
 * trivial — a plain post-parse tree walk (unlike KaTeX's real
 * micromark-level `remark-math` syntax extension), because only the
 * registration SHAPE matters for these tests, not parsing
 * sophistication.
 *
 * **MUST NOT be imported from production code paths.** Same
 * `NODE_ENV==='test'` guard as `echo-embed.ts`.
 */
import type { NodeRenderer } from '@crowi/plugin-api';
import type { PhrasingContent, Root, Text } from 'mdast';

const FAKE_MATH_RE = /\{\{fm:([^{}]{1,256})\}\}/g;

export const FAKE_MATH_NODE_TYPE = 'fakeMath';

interface WalkableNode {
  type?: string;
  children?: unknown[];
}

function walk(node: WalkableNode): void {
  if (node.type === 'code' || node.type === 'inlineCode') return;
  if (Array.isArray(node.children)) {
    node.children = expandChildren(node.children as PhrasingContent[]);
    for (const child of node.children) walk(child as WalkableNode);
  }
}

function expandChildren(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child.type !== 'text') {
      out.push(child);
      continue;
    }
    out.push(...expandText(child as Text));
  }
  return out;
}

function expandText(textNode: Text): PhrasingContent[] {
  const value = textNode.value;
  if (!value || !value.includes('{{fm:')) return [textNode];
  const out: PhrasingContent[] = [];
  let lastIndex = 0;
  FAKE_MATH_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null = FAKE_MATH_RE.exec(value); m !== null; m = FAKE_MATH_RE.exec(value)) {
    const [matched, raw] = m;
    const start = m.index;
    if (start > lastIndex) out.push({ type: 'text', value: value.slice(lastIndex, start) });
    out.push({ type: FAKE_MATH_NODE_TYPE, value: raw } as unknown as PhrasingContent);
    lastIndex = start + matched.length;
  }
  if (lastIndex === 0) return [textNode];
  if (lastIndex < value.length) out.push({ type: 'text', value: value.slice(lastIndex) });
  return out;
}

/**
 * The unified-plugin factory handed to `registry.addUnifiedPlugin`
 * (mirrors `remarkMathUnifiedPlugin` in the real KaTeX plugin — a
 * plain `() => (tree) => void` transformer).
 */
export function fakeMathUnifiedPlugin(): (tree: Root) => void {
  return (tree) => walk(tree as unknown as WalkableNode);
}

interface MutableFakeMathNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: unknown[];
}

/** NodeRenderer mutating a `fakeMath` node into a clean `html` shape — mirrors KaTeX's `renderMathInline`. */
export const fakeMathRenderer: NodeRenderer = (node, _ctx) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('[crowi:renderer:__fixtures__/fake-math-embed] This fixture plugin is for tests only. Do not register it from production code.');
  }
  const mathNode = node as MutableFakeMathNode;
  const raw = mathNode.value ?? '';
  mathNode.type = 'html';
  mathNode.value = `<span class="fake-math">${raw}</span>`;
  delete mathNode.children;
  delete mathNode.data;
};
