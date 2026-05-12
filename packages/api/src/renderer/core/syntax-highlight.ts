import type { Code, Html, Root, RootContent } from 'mdast';
import type { PipelineEsmDeps, PipelineMetadata, ShikiHighlighter } from '../pipeline';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — replace fenced code-block (`code`) nodes
 * with `html` nodes carrying shiki-rendered `<pre><code>...</code></pre>`
 * markup. Inline code (`inlineCode`) is intentionally left alone so the
 * web `components.code` path keeps owning inline rendering.
 *
 * Behaviour for fence languages:
 *   - shiki-supported lang  → replace with `html` node (shiki output)
 *   - missing or unknown lang → leave the `code` node intact, web side
 *     falls back to `<pre><code class="language-x">` rendering
 *
 * The factory takes `deps` because shiki itself is ESM-only and is
 * loaded via the same jiti mechanism as unified / remark-* / slugger.
 * Sequencing-wise this plugin runs AFTER `remarkCodeBlockLanguages`
 * (the lang-aggregator) so the pure-observer pass sees the still-mdast
 * `code` nodes; once we replace them with `html` nodes the aggregator
 * would no longer find them.
 */
export const makeRemarkSyntaxHighlight =
  (deps: PipelineEsmDeps): UnifiedTransformPlugin =>
  (_metadata: PipelineMetadata) =>
  (tree: Root): void => {
    const highlighter = deps.shikiHighlighter;
    walk(tree, highlighter);
  };

interface MutableParent {
  type?: string;
  children?: RootContent[];
}

function walk(node: MutableParent, highlighter: ShikiHighlighter): void {
  if (!Array.isArray(node.children)) return;
  // Replace child code-nodes in place — inline (`inlineCode`) is not in
  // the iterated parent's child list as a fence anyway, but we also
  // gate on `type === 'code'` to be defensive.
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'code') {
      const replacement = renderCode(child as Code, highlighter);
      if (replacement) {
        node.children[i] = replacement;
      }
      continue;
    }
    walk(child as unknown as MutableParent, highlighter);
  }
}

function renderCode(code: Code, highlighter: ShikiHighlighter): Html | null {
  const lang = (code.lang ?? '').trim();
  if (!lang) return null; // no language → web-side plain fallback
  if (!highlighter.hasLang(lang)) return null; // unknown → fallback path
  const value = code.value ?? '';
  // shiki output is escaped + wrapped in `<pre class="shiki ..."><code>`;
  // the `<pre>` carries inline `style="background-color: ..."` for the
  // bundled theme. We persist this verbatim on the AST as an `html` node.
  let html: string;
  try {
    html = highlighter.codeToHtml(value, lang);
  } catch {
    return null; // shiki internal error → fallback path
  }
  return { type: 'html', value: html };
}
