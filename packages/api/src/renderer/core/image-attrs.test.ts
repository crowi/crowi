import type { Image, PhrasingContent, Root, RootContent, Text } from 'mdast';
import type { Position } from 'unist';
import { createJiti } from 'jiti';
import type { PipelineMetadata } from '../pipeline';
import { remarkImageAttrs, type ImageFigureNode } from './image-attrs';
import { remarkMentions } from './mentions';
import { remarkWikiLinks } from './wikilinks';

/** Fresh, empty `PipelineMetadata` — this transform doesn't aggregate into it, but the plugin factory signature requires one. */
function emptyMetadata(): PipelineMetadata {
  return { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };
}

function image(url: string, alt: string | null = null): Image {
  return { type: 'image', url, alt, title: null };
}

function text(value: string): Text {
  return { type: 'text', value };
}

/** A `root` whose single top-level child is a `paragraph` holding `children`. */
function rootWithParagraph(...children: PhrasingContent[]): Root {
  return { type: 'root', children: [{ type: 'paragraph', children }] };
}

function run(tree: Root): void {
  remarkImageAttrs(emptyMetadata())(tree);
}

/** Cast a post-transform `RootContent` to the synthesized figure shape (not a real `RootContentMap` member — see `image-attrs.ts`). */
function asFigure(node: RootContent): ImageFigureNode {
  return node as unknown as ImageFigureNode;
}

describe('core/image-attrs transform', () => {
  describe('standalone vs inline (AC-A1, AC-A6, AC-A7)', () => {
    it('replaces the paragraph with a figure for a width-only standalone image', () => {
      const tree = rootWithParagraph(image('/x.png', 'alt'), text('{width=60%}'));
      run(tree);

      expect(tree.children).toHaveLength(1);
      const figure = asFigure(tree.children[0]);
      expect(figure.type).toBe('crowiFigure');
      expect(figure.data.hName).toBe('figure');
      expect(figure.data.hProperties.className).toBe('crowi-figure');
      expect(figure.data.hProperties['data-crowi-image-align']).toBeUndefined();
      expect(figure.data.hProperties['data-crowi-image-float']).toBeUndefined();

      expect(figure.children).toHaveLength(1);
      const inner = figure.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
      expect(inner.url).toBe('/x.png');
      expect(inner.data?.hProperties?.['data-crowi-image-width']).toBe('60%');
    });

    it('keeps an attributed image inline (no figure) when trailing text follows, and preserves the trailing text', () => {
      const tree = rootWithParagraph(image('/x.png', 'alt'), text('{width=60%} trailing text'));
      run(tree);

      expect(tree.children).toHaveLength(1);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph'); // NOT replaced with a figure
      expect(paragraph.children).toHaveLength(2);

      const img = paragraph.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
      expect(img.data?.hProperties?.['data-crowi-image-width']).toBe('60%');

      const trailing = paragraph.children[1] as Text;
      expect(trailing.value).toBe(' trailing text');
    });

    it('keeps both images inline when two attributed images share one paragraph (another inline sibling present)', () => {
      const tree = rootWithParagraph(image('/a.png'), text('{width=10%} '), image('/b.png'), text('{width=20%}'));
      run(tree);

      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph');
      const imgA = paragraph.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
      const imgB = paragraph.children[2] as Image & { data?: { hProperties?: Record<string, unknown> } };
      expect(imgA.data?.hProperties?.['data-crowi-image-width']).toBe('10%');
      expect(imgB.data?.hProperties?.['data-crowi-image-width']).toBe('20%');
    });

    it('stays inline when a non-text inline sibling (e.g. emphasis) follows the attributed image', () => {
      const emphasis = { type: 'emphasis', children: [text('hi')] } as unknown as PhrasingContent;
      const tree = rootWithParagraph(image('/x.png'), text('{width=60%} '), emphasis);
      run(tree);

      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph');
      const img = paragraph.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
      expect(img.data?.hProperties?.['data-crowi-image-width']).toBe('60%');
    });
  });

  it('validates a px height value (AC-A2)', () => {
    const tree = rootWithParagraph(image('/x.png'), text('{height=240px}'));
    run(tree);
    const figure = asFigure(tree.children[0]);
    const inner = figure.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
    expect(inner.data?.hProperties?.['data-crowi-image-height']).toBe('240px');
  });

  it('validates align + float on a standalone image, keeping both off the inner image (layer split) (AC-A3, AC-A4)', () => {
    const tree = rootWithParagraph(image('/x.png'), text('{align=left float=right}'));
    run(tree);

    const figure = asFigure(tree.children[0]);
    expect(figure.data.hProperties['data-crowi-image-align']).toBe('left');
    expect(figure.data.hProperties['data-crowi-image-float']).toBe('right');

    const inner = figure.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
    expect(inner.data?.hProperties?.['data-crowi-image-align']).toBeUndefined();
    expect(inner.data?.hProperties?.['data-crowi-image-float']).toBeUndefined();
    expect(inner.data?.hProperties?.['data-crowi-image-width']).toBeUndefined();
  });

  describe('DROP on out-of-range / invalid / unknown (AC-A5)', () => {
    const cases: Array<[string, string]> = [
      ['non-numeric width', '{width=abc}'],
      ['width over 100%', '{width=200%}'],
      ['width at 0%', '{width=0%}'],
      ['height over 4096px', '{height=5000px}'],
      ['height at 0px', '{height=0px}'],
      ['unknown enum value for align', '{align=middle}'],
      ['unknown key', '{foo=bar}'],
    ];

    it.each(cases)('%s leaves the image and text completely unchanged', (_label, block) => {
      const originalText = `${block} more`;
      const tree = rootWithParagraph(image('/x.png', 'alt'), text(originalText));
      run(tree);

      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph');
      const img = paragraph.children[0] as Image & { data?: unknown };
      expect(img.data).toBeUndefined();
      const trailing = paragraph.children[1] as Text;
      expect(trailing.value).toBe(originalText);
    });

    it('keeps the boundary values valid (100%, 1%, 4096px, 1px)', () => {
      const tree = rootWithParagraph(image('/x.png'), text('{width=100%}'));
      run(tree);
      const figure = asFigure(tree.children[0]);
      const inner = figure.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
      expect(inner.data?.hProperties?.['data-crowi-image-width']).toBe('100%');
    });
  });

  describe('whitespace / soft-break prefix handling (AC-A8)', () => {
    it('accepts zero spaces between the image and the brace', () => {
      const tree = rootWithParagraph(image('/x.png'), text('{width=1%}'));
      run(tree);
      expect(asFigure(tree.children[0]).type).toBe('crowiFigure');
    });

    it('accepts multiple ASCII spaces/tabs between the image and the brace', () => {
      const tree = rootWithParagraph(image('/x.png'), text('  \t {width=1%}'));
      run(tree);
      expect(asFigure(tree.children[0]).type).toBe('crowiFigure');
    });

    it('accepts exactly one soft line break + spaces before the brace', () => {
      const tree = rootWithParagraph(image('/x.png'), text('\n  {width=1%}'));
      run(tree);
      expect(asFigure(tree.children[0]).type).toBe('crowiFigure');
    });

    it('rejects two or more soft line breaks before the brace (text stays unchanged)', () => {
      const original = '\n\n{width=1%}';
      const tree = rootWithParagraph(image('/x.png'), text(original));
      run(tree);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph');
      expect((paragraph.children[1] as Text).value).toBe(original);
    });

    it('rejects non-whitespace text before the brace', () => {
      const original = 'abc {width=1%}';
      const tree = rootWithParagraph(image('/x.png'), text(original));
      run(tree);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect((paragraph.children[1] as Text).value).toBe(original);
    });

    it('rejects a block with a leading space right after the opening brace ("{ width=1%}")', () => {
      const original = '{ width=1%}';
      const tree = rootWithParagraph(image('/x.png'), text(original));
      run(tree);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect((paragraph.children[1] as Text).value).toBe(original);
    });
  });

  it('preserves only the unconsumed remainder of the text node (partial text-node preservation, AC-A9)', () => {
    const tree = rootWithParagraph(image('/x.png'), text('{width=60%}  and some more text'));
    run(tree);
    const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
    expect(paragraph.type).toBe('paragraph');
    expect((paragraph.children[1] as Text).value).toBe('  and some more text');
  });

  describe('bounded scanner (AC-A10)', () => {
    it('completes quickly and leaves text unchanged for a huge unterminated block', () => {
      const huge = `{${'a'.repeat(50_000)}`; // no closing `}` anywhere
      const original = `${huge} tail`;
      const tree = rootWithParagraph(image('/x.png'), text(original));

      const start = Date.now();
      run(tree);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(200);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect(paragraph.type).toBe('paragraph');
      expect((paragraph.children[1] as Text).value).toBe(original);
    });

    it('leaves text unchanged for a nested-brace / invalid-token block', () => {
      const original = '{width=1{nested}} tail';
      const tree = rootWithParagraph(image('/x.png'), text(original));
      run(tree);
      const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
      expect((paragraph.children[1] as Text).value).toBe(original);
    });
  });

  it('copies the source paragraph position onto the synthesized figure (AC-A11)', () => {
    const position: Position = { start: { line: 3, column: 1, offset: 20 }, end: { line: 3, column: 30, offset: 49 } };
    const tree: Root = { type: 'root', children: [{ type: 'paragraph', position, children: [image('/x.png'), text('{width=60%}')] }] };
    run(tree);
    const figure = asFigure(tree.children[0]);
    expect(figure.position).toBe(position);
  });

  describe('toHast output (AC-A12, §D9 option (a))', () => {
    interface HastText {
      type: 'text';
      value: string;
    }
    interface HastElement {
      type: 'element';
      tagName: string;
      properties: Record<string, unknown>;
      children: Array<HastElement | HastText>;
    }
    interface HastRoot {
      type: 'root';
      children: Array<HastElement | HastText>;
    }

    function loadToHast(): (tree: unknown, options?: { allowDangerousHtml?: boolean }) => HastRoot {
      // `mdast-util-to-hast` is ESM-only; loaded the same way the pipeline
      // loads `unified`/`remark-parse`/etc (see `pipeline.ts`'s
      // `createPipelineEsmDepsLoader` doc comment) so this test doesn't
      // trip over ts-jest's CJS `require()` interop with an ESM package.
      const jiti = createJiti(__filename, { interopDefault: true });
      const mod = jiti('mdast-util-to-hast') as { toHast: (tree: unknown, options?: unknown) => unknown };
      return mod.toHast as (tree: unknown, options?: { allowDangerousHtml?: boolean }) => HastRoot;
    }

    it('emits <figure> + inner <img> with src/alt/data-crowi-image-* preserved', () => {
      const tree = rootWithParagraph(image('/x.png', 'a photo'), text('{width=60% align=center}'));
      run(tree);

      const toHast = loadToHast();
      const hast = toHast(tree, { allowDangerousHtml: true });

      expect(hast.children).toHaveLength(1);
      const figureEl = hast.children[0] as HastElement;
      expect(figureEl.type).toBe('element');
      expect(figureEl.tagName).toBe('figure');
      expect(figureEl.properties.className).toBe('crowi-figure');
      expect(figureEl.properties['data-crowi-image-align']).toBe('center');
      expect(figureEl.properties['data-crowi-image-width']).toBeUndefined();

      expect(figureEl.children).toHaveLength(1);
      const imgEl = figureEl.children[0] as HastElement;
      expect(imgEl.tagName).toBe('img');
      expect(imgEl.properties.src).toBe('/x.png');
      expect(imgEl.properties.alt).toBe('a photo');
      expect(imgEl.properties['data-crowi-image-width']).toBe('60%');
      expect(imgEl.properties['data-crowi-image-align']).toBeUndefined();
    });
  });

  it('runs before wikilinks/mentions so a `{...}` block is consumed intact instead of split (AC-A13)', () => {
    // Mirrors what `buildCorePlugins`' fixed order guarantees (headings →
    // image-attrs → wikilinks → mentions); calling the transforms directly
    // in that relative order is a lighter-weight equivalent of running the
    // full `unified` pipeline for this ordering-only concern (headings /
    // syntax-highlight need ESM deps that are irrelevant here).
    const tree = rootWithParagraph(image('/x.png'), text('{width=60%} see [[Wiki Page]] and @alice'));
    const metadata = emptyMetadata();

    remarkImageAttrs(metadata)(tree);
    remarkWikiLinks(metadata)(tree);
    remarkMentions(metadata)(tree);

    const paragraph = tree.children[0] as { type: string; children: PhrasingContent[] };
    expect(paragraph.type).toBe('paragraph');
    const img = paragraph.children[0] as Image & { data?: { hProperties?: Record<string, unknown> } };
    expect(img.data?.hProperties?.['data-crowi-image-width']).toBe('60%');

    // wikilinks/mentions ran on the already-trimmed remainder and still
    // produced their usual link nodes — proving the `{...}` text node was
    // intact (not yet split) when image-attrs inspected it.
    const types = paragraph.children.map((c) => c.type);
    expect(types).toContain('link');
    expect(metadata.wikiLinks).toHaveLength(1);
    expect(metadata.mentions).toEqual([{ username: 'alice' }]);
  });

  it('is a no-op for a plain image with no attribute block (AC-X1)', () => {
    const tree = rootWithParagraph(image('/x.png', 'alt'));
    const before = JSON.parse(JSON.stringify(tree));
    run(tree);
    expect(tree).toEqual(before);
  });
});
