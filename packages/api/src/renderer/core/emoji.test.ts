import { createJiti } from 'jiti';
import type { Root } from 'mdast';
import { emojiUnifiedPlugin, loadRemarkEmoji } from './emoji';

/**
 * Unit tests for the core emoji transform (feature-renderer-plugin-
 * boundary Phase 3) — moved + adapted from the previous standalone
 * emoji renderer plugin's own test suite. The
 * `CrowiPlugin.registerRenderer` wrapper-call assertions from that file
 * are dropped: emoji is no longer a registry-registered plugin, it is a
 * direct `pipeline.ts` `.use()` call (see `pipeline.test.ts`'s "emoji
 * (core, post-remarkBreaks transform)" describe block for the
 * `runPipeline`-level integration coverage of that — no registry
 * registration required, applied unconditionally, ordered before
 * external registry transforms).
 */

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

/**
 * Build a unified processor + remark-parse processor and apply the
 * loaded remark-emoji directly (with the same options the transform
 * applies), then parse + runSync the body. Returns the transformed
 * mdast tree.
 */
function buildEmojiProcessor(): UnifiedProcessor {
  const jiti = createJiti(__filename, { interopDefault: true });
  const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
  const remarkParseMod = jiti('remark-parse') as { default: unknown };
  const remarkEmoji = loadRemarkEmoji();
  return unifiedMod
    .unified()
    .use(remarkParseMod.default)
    .use(remarkEmoji as never, { accessible: true, emoticon: false, padSpaceAfter: false });
}

type NodeShape = { type?: string; value?: string; data?: { hName?: string; hProperties?: Record<string, unknown> }; children?: NodeShape[] };

/**
 * Walk an mdast tree depth-first (document order) and collect every
 * node matching `predicate`. Shared by every assertion below that
 * needs to inspect the transformed tree, so the walk itself is written
 * once.
 */
function collectNodes(tree: Root, predicate: (node: NodeShape) => boolean): NodeShape[] {
  const out: NodeShape[] = [];
  const stack: NodeShape[] = [tree as NodeShape];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
  return out;
}

/**
 * Collect every `text` node's value. The remark-emoji transform
 * mutates text nodes in place, so the concatenated values describe
 * what users would see after the transform runs.
 */
function collectTextValues(tree: Root): string[] {
  return collectNodes(tree, (n) => n.type === 'text' && typeof n.value === 'string').map((n) => n.value as string);
}

describe('core emoji transform', () => {
  it('emojiUnifiedPlugin is a unified-plugin-shaped function', () => {
    expect(typeof emojiUnifiedPlugin).toBe('function');
  });

  it('caches the remark-emoji load across loadRemarkEmoji calls', () => {
    const first = loadRemarkEmoji();
    const second = loadRemarkEmoji();
    expect(first).toBe(second);
  });

  it('end-to-end: `:smile:` is replaced with the unicode emoji', () => {
    const processor = buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('Hi :smile: there!'));
    const texts = collectTextValues(tree).join('|');
    expect(texts).toContain('😄');
  });

  it('end-to-end: unknown shortcode `:not-emoji:` is preserved verbatim', () => {
    const processor = buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('try :not-emoji: maybe'));
    const texts = collectTextValues(tree).join('');
    expect(texts).toContain(':not-emoji:');
  });

  it('end-to-end: `:smile:` inside a fenced code block is NOT replaced', () => {
    const processor = buildEmojiProcessor();
    const md = ['```', ':smile:', '```'].join('\n');
    const tree = processor.runSync(processor.parse(md));
    // The code block is a leaf with `value` carrying the raw source.
    const codeNode = tree.children[0] as { type: string; value?: string };
    expect(codeNode.type).toBe('code');
    expect(codeNode.value).toBe(':smile:');
  });

  it('end-to-end: `:smile:` inside inline code is NOT replaced', () => {
    const processor = buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('live `:smile:` and bare :smile: end.'));
    // Collect inlineCode text + regular text — the inlineCode value
    // should still be `:smile:`, only the bare one was substituted.
    const inlineCodeValues = collectNodes(tree, (n) => n.type === 'inlineCode' && typeof n.value === 'string').map((n) => n.value as string);
    expect(inlineCodeValues).toContain(':smile:');
    // And the bare one was replaced in text nodes.
    expect(collectTextValues(tree).join('')).toContain('😄');
  });

  it('end-to-end: accessible:true stamps mdast-to-hast props (role=img + aria-label) on the emoji text node', () => {
    // remark-emoji's accessible mode does NOT emit an html node — it
    // attaches `data.hName='span'` + `data.hProperties={role,ariaLabel}`
    // to the text node, which mdast-util-to-hast / hast-util-to-html
    // turns into `<span role="img" aria-label="smile emoji">😄</span>`
    // at HTML emission. We assert the mdast-level stamp here.
    const processor = buildEmojiProcessor();
    const tree = processor.runSync(processor.parse(':smile:'));
    const stamped = collectNodes(tree, (n) => n.type === 'text' && n.data?.hName === 'span' && n.data.hProperties?.role === 'img')[0] ?? null;
    expect(stamped).not.toBeNull();
    const ariaLabel = stamped?.data?.hProperties?.ariaLabel;
    expect(typeof ariaLabel).toBe('string');
    expect(ariaLabel).toMatch(/smile/);
  });
});
