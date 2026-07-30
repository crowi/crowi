import type { Code, Html, Root } from 'mdast';
import type { PipelineEsmDeps, ShikiHighlighter } from '../pipeline';
import { makeRemarkSyntaxHighlight } from './syntax-highlight';
import { createEmptyPipelineMetadata } from '../pipeline';

// Minimal stub deps: only `shikiHighlighter` is read by the plugin
// itself. The rest of `PipelineEsmDeps` is irrelevant here.
function makeStubDeps(highlighter: ShikiHighlighter): PipelineEsmDeps {
  return {
    unified: (() => {
      throw new Error('unused');
    }) as unknown as PipelineEsmDeps['unified'],
    remarkParse: undefined,
    remarkGfm: undefined,
    GithubSlugger: class {
      slug() {
        return '';
      }
    },
    mdastToString: () => '',
    shikiHighlighter: highlighter,
  };
}

const fakeHighlighter: ShikiHighlighter = {
  hasLang: (lang) => ['ts', 'js', 'python'].includes(lang),
  codeToHtml: (code, lang) => `<pre class="shiki" lang="${lang}"><code>${code.replace(/</g, '&lt;')}</code></pre>`,
  // RFC-0023 — one line of one token, both theme variants, a fontStyle
  // present on the light side only (exercises the optional field).
  codeToTokens: (code) => [[{ content: code, light: { color: '#111111', fontStyle: ['bold'] }, dark: { color: '#eeeeee' } }]],
};

const runPlugin = (tree: Root): Root => {
  const deps = makeStubDeps(fakeHighlighter);
  const plugin = makeRemarkSyntaxHighlight(deps);
  const transformer = plugin(createEmptyPipelineMetadata());
  transformer(tree);
  return tree;
};

describe('makeRemarkSyntaxHighlight', () => {
  it('replaces a known-language code block with an html node', () => {
    const codeNode: Code = { type: 'code', lang: 'ts', value: 'const x: number = 1;' };
    const tree: Root = { type: 'root', children: [codeNode] };
    runPlugin(tree);
    expect(tree.children[0].type).toBe('html');
    const html = tree.children[0] as Html;
    expect(html.value).toContain('<pre class="shiki" lang="ts">');
    expect(html.value).toContain('const x: number = 1;');
  });

  it('leaves a fence with no lang as a `code` node (web-side fallback)', () => {
    const codeNode: Code = { type: 'code', lang: null, value: 'plain' };
    const tree: Root = { type: 'root', children: [codeNode] };
    runPlugin(tree);
    expect(tree.children[0].type).toBe('code');
  });

  it('leaves an unknown-language fence as a `code` node (web-side fallback)', () => {
    const codeNode: Code = { type: 'code', lang: 'brainfuck', value: '+++' };
    const tree: Root = { type: 'root', children: [codeNode] };
    runPlugin(tree);
    expect(tree.children[0].type).toBe('code');
    const code = tree.children[0] as Code;
    expect(code.lang).toBe('brainfuck');
  });

  it('does not touch inlineCode nodes (only fenced `code` blocks)', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: 'foo()' }],
        },
      ],
    };
    runPlugin(tree);
    const para = tree.children[0] as { children: Array<{ type: string }> };
    expect(para.children[0].type).toBe('inlineCode');
  });

  it('falls back to the `code` node when the highlighter throws', () => {
    const throwingHighlighter: ShikiHighlighter = {
      hasLang: () => true,
      codeToHtml: () => {
        throw new Error('shiki internal');
      },
    };
    const codeNode: Code = { type: 'code', lang: 'ts', value: 'x' };
    const tree: Root = { type: 'root', children: [codeNode] };
    const deps = makeStubDeps(throwingHighlighter);
    const plugin = makeRemarkSyntaxHighlight(deps);
    plugin(createEmptyPipelineMetadata())(tree);
    expect(tree.children[0].type).toBe('code');
  });

  it('walks into nested children (e.g. list items containing fences)', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'code',
                  lang: 'js',
                  value: '1 + 1',
                } as unknown as Code,
              ],
            },
          ],
        },
      ],
    } as unknown as Root;
    runPlugin(tree);
    const listItem = (tree.children[0] as { children: Array<{ children: Array<{ type: string }> }> }).children[0];
    expect(listItem.children[0].type).toBe('html');
  });
});

/**
 * RFC-0023 §10 — shiki keeps its html node byte-identical and stamps
 * the `crowiCode` sidecar (lang / original value / themed token lines)
 * onto `data`. A token-derivation failure only skips the sidecar.
 */
describe('crowiCode sidecar (RFC-0023)', () => {
  it('stamps data.crowiCode with lang, the ORIGINAL source and both-theme token lines; the html value is byte-identical to codeToHtml', () => {
    const codeNode: Code = { type: 'code', lang: 'ts', value: 'const x = 1;' };
    const tree: Root = { type: 'root', children: [codeNode] };
    runPlugin(tree);
    const html = tree.children[0] as Html & { data?: { crowiCode?: { lang?: string; value: string; tokens: unknown[][] } } };
    expect(html.type).toBe('html');
    expect(html.value).toBe(fakeHighlighter.codeToHtml('const x = 1;', 'ts'));
    expect(html.data?.crowiCode?.lang).toBe('ts');
    expect(html.data?.crowiCode?.value).toBe('const x = 1;');
    expect(html.data?.crowiCode?.tokens).toEqual([[{ content: 'const x = 1;', light: { color: '#111111', fontStyle: ['bold'] }, dark: { color: '#eeeeee' } }]]);
  });

  it('a codeToTokens failure produces the SAME html node without a sidecar (html output unaffected)', () => {
    const throwingHighlighter: ShikiHighlighter = {
      ...fakeHighlighter,
      codeToTokens: () => {
        throw new Error('token derivation exploded');
      },
    };
    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'ts', value: 'const y = 2;' }] };
    const plugin = makeRemarkSyntaxHighlight(makeStubDeps(throwingHighlighter));
    plugin(createEmptyPipelineMetadata())(tree);
    const html = tree.children[0] as Html & { data?: unknown };
    expect(html.type).toBe('html');
    expect(html.value).toBe(fakeHighlighter.codeToHtml('const y = 2;', 'ts'));
    expect(html.data).toBeUndefined();
  });

  it('fallback fences (no lang / unknown lang) get neither an html node nor a sidecar — the plain code node survives untouched', () => {
    const tree: Root = {
      type: 'root',
      children: [
        { type: 'code', lang: null, value: 'plain' },
        { type: 'code', lang: 'brainfuck', value: '+++' },
      ],
    };
    runPlugin(tree);
    for (const child of tree.children as Array<{ type: string; data?: unknown }>) {
      expect(child.type).toBe('code');
      expect(child.data).toBeUndefined();
    }
  });
});
