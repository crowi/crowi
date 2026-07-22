import { createJiti } from 'jiti';
import type { Root } from 'mdast';
import type { PluginLogger, RendererRegistry, RenderPhase } from '@crowi/plugin-api';
import emojiPlugin, { loadRemarkEmoji } from './index';

/**
 * Minimal RendererRegistry capture stub — mirrors the shape used by
 * `packages/api/src/renderer/registry.ts`. Lets us assert
 * `registerRenderer` queues exactly one unified plugin on the transform
 * phase without coupling the plugin unit-test to the api package.
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
    addStylesheet: () => undefined,
  };
  return { scope, captured };
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

/**
 * Build a unified processor + remark-parse processor and apply the
 * loaded remark-emoji directly (with the same options the plugin
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

/**
 * Walk an mdast tree and collect every `text` node's value. The
 * remark-emoji transform mutates text nodes in place, so the
 * concatenated values describe what users would see after the
 * transform runs.
 */
function collectTextValues(tree: Root): string[] {
  const out: string[] = [];
  const stack: Array<{ type?: string; value?: string; children?: Array<unknown> }> = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'text' && typeof node.value === 'string') {
      out.push(node.value);
    }
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i] as { type?: string; value?: string; children?: Array<unknown> });
      }
    }
  }
  return out;
}

describe('@crowi/plugin-renderer-emoji', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(emojiPlugin.name).toBe('@crowi/plugin-renderer-emoji');
    expect(emojiPlugin.version).toBe('0.1.0-dev');
    expect(typeof emojiPlugin.registerRenderer).toBe('function');
  });

  it('registers exactly one transform-phase unified plugin', () => {
    const { scope, captured } = makeRegistry();
    emojiPlugin.registerRenderer?.(scope, {
      log: silentLogger,
    } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].phase).toBe('transform');
    expect(typeof captured[0].plugin).toBe('function');
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
    const inlineCodeValues: string[] = [];
    const stack: Array<{ type?: string; value?: string; children?: Array<unknown> }> = [tree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.type === 'inlineCode' && typeof node.value === 'string') {
        inlineCodeValues.push(node.value);
      }
      if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i] as { type?: string; value?: string; children?: Array<unknown> });
        }
      }
    }
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
    type NodeShape = { type?: string; value?: string; data?: { hName?: string; hProperties?: Record<string, unknown> }; children?: NodeShape[] };
    const stack: NodeShape[] = [tree as NodeShape];
    let stamped: NodeShape | null = null;
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.type === 'text' && node.data?.hName === 'span' && node.data.hProperties?.role === 'img') {
        stamped = node;
        break;
      }
      if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
    expect(stamped).not.toBeNull();
    const ariaLabel = stamped?.data?.hProperties?.ariaLabel;
    expect(typeof ariaLabel).toBe('string');
    expect(ariaLabel).toMatch(/smile/);
  });
});
