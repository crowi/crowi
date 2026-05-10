import type { Code, Html, Root } from 'mdast';
import type { PipelineEsmDeps, ShikiHighlighter } from '../pipeline';
import { makeRemarkSyntaxHighlight } from './syntax-highlight';

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
};

const runPlugin = (tree: Root): Root => {
  const deps = makeStubDeps(fakeHighlighter);
  const plugin = makeRemarkSyntaxHighlight(deps);
  const transformer = plugin({ toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] });
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
    plugin({ toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] })(tree);
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
