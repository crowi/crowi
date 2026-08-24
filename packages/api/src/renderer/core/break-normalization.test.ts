import type { Break, Heading, Html, Paragraph, PhrasingContent, Position, Root, RootContent, TableCell } from 'mdast';
import { RENDERED_AST_NODE_DEFS } from '@crowi/api-contract';
import { createEmptyPipelineMetadata } from '../pipeline';
import { BARE_HTML_BREAK_RE, BREAK_PARENT_TYPES, PHRASING_UNIT_TYPES, remarkNormalizeHtmlBreaks } from './break-normalization';

/**
 * Isolated unit coverage of the transform itself (real-parser end-to-end
 * cases, including the ones that need `remarkGfm`'s table support or
 * core-transform ordering, live in `pipeline.test.ts`) — same split as
 * `core/frontmatter.test.ts` / `core/github-alerts.test.ts`.
 */

function runTransform(tree: Root): void {
  remarkNormalizeHtmlBreaks(createEmptyPipelineMetadata())(tree);
}

const text = (value: string): PhrasingContent => ({ type: 'text', value });
const html = (value: string, extra: Partial<Html> = {}): Html => ({ type: 'html', value, ...extra });
const paragraph = (...children: PhrasingContent[]): Paragraph => ({ type: 'paragraph', children });
const heading = (depth: Heading['depth'], ...children: PhrasingContent[]): Heading => ({ type: 'heading', depth, children });
const tableCell = (...children: PhrasingContent[]): TableCell => ({ type: 'tableCell', children });
const root = (...children: RootContent[]): Root => ({ type: 'root', children });

const pos = (startOffset: number, endOffset: number): Position => ({
  start: { line: 1, column: startOffset + 1, offset: startOffset },
  end: { line: 1, column: endOffset + 1, offset: endOffset },
});

describe('core/break-normalization transform', () => {
  describe('BARE_HTML_BREAK_RE (D-2)', () => {
    it.each(['<br>', '<br/>', '<br />', '<BR>', '<Br/>', '<bR />'])('matches the accepted form %s', (value) => {
      expect(BARE_HTML_BREAK_RE.test(value)).toBe(true);
    });

    it.each([
      '<br >',
      '<br\t/>',
      '<br\n/>',
      '<br  />',
      ' <br>',
      '<br> ',
      '<br class="x">',
      '<hr>',
      '<br><br>',
      'before<br>',
      '<br>after',
    ])('rejects %s', (value) => {
      expect(BARE_HTML_BREAK_RE.test(value)).toBe(false);
    });
  });

  describe('exported constants (D-3 / D-4)', () => {
    it('PHRASING_UNIT_TYPES is exactly paragraph/heading/tableCell', () => {
      expect(PHRASING_UNIT_TYPES).toEqual(new Set(['paragraph', 'heading', 'tableCell']));
    });

    // Derived from the registry rather than restated, so a newly added
    // `childModel: 'phrasing'` type has to be either covered here or
    // excluded on purpose — it cannot silently lose normalization.
    it('BREAK_PARENT_TYPES covers every phrasing-childModel registry type except the documented exclusion', () => {
      const phrasingParents = Object.entries(RENDERED_AST_NODE_DEFS)
        .filter(([, def]) => def.childModel === 'phrasing')
        .map(([name]) => name);
      // `crowiFigure` cannot hold an `html` child — see BREAK_PARENT_TYPES' doc comment.
      const expected = new Set(phrasingParents.filter((name) => name !== 'crowiFigure'));
      expect(BREAK_PARENT_TYPES).toEqual(expected);
    });
  });

  describe('AC-1: accepted forms convert to `break`, in paragraph and tableCell, preserving surrounding text order', () => {
    it.each(['<br>', '<br/>', '<br />', '<BR>', '<Br/>', '<bR />'])('converts a bare %s between two text runs in a paragraph', (form) => {
      const tree = root(paragraph(text('a'), html(form), text('b')));
      runTransform(tree);
      expect((tree.children[0] as Paragraph).children).toEqual([text('a'), { type: 'break' }, text('b')]);
    });

    it('converts a bare `<br>` inside a tableCell', () => {
      const tree = root(tableCell(text('a'), html('<br>'), text('b')) as unknown as RootContent);
      runTransform(tree);
      expect((tree.children[0] as unknown as TableCell).children).toEqual([text('a'), { type: 'break' }, text('b')]);
    });

    it('converts a bare `<br>` inside a heading', () => {
      const tree = root(heading(3, text('a'), html('<br>'), text('b')));
      runTransform(tree);
      expect((tree.children[0] as Heading).children).toEqual([text('a'), { type: 'break' }, text('b')]);
    });
  });

  describe('AC-2: negative value matrix — anything other than the exact 3 forms stays `html`', () => {
    it.each([
      ['leading/trailing whitespace inside the value', ' <br> '],
      ['a space before `>` with no slash', '<br >'],
      ['a tab before the slash', '<br\t/>'],
      ['a newline before the slash', '<br\n/>'],
      ['two spaces before the slash', '<br  />'],
      ['an attribute', '<br class="x">'],
      ['a different tag', '<hr>'],
      ['two tags in one node value', '<br><br>'],
      ['leading text sharing the node', 'before<br>'],
      ['trailing text sharing the node', '<br>after'],
    ])('rejects: %s (%s)', (_label, value) => {
      const tree = root(paragraph(text('a'), html(value), text('b')));
      runTransform(tree);
      expect((tree.children[0] as Paragraph).children).toEqual([text('a'), html(value), text('b')]);
    });
  });

  describe('AC-3: replacement shape (position-only) and direct-parent allow-list', () => {
    it('copies `position` from the source `html` node onto the `break` node', () => {
      const node = html('<br>', { position: pos(3, 7) });
      const tree = root(paragraph(text('a'), node, text('b')));
      runTransform(tree);
      const replaced = (tree.children[0] as Paragraph).children[1] as Break;
      expect(replaced).toEqual({ type: 'break', position: pos(3, 7) });
    });

    it('omits `position` entirely when the source node has none (no `position: undefined` key)', () => {
      const tree = root(paragraph(html('<br>')));
      runTransform(tree);
      const replaced = (tree.children[0] as Paragraph).children[0] as Break;
      expect(replaced).toEqual({ type: 'break' });
      expect(Object.keys(replaced)).toEqual(['type']);
    });

    it('never carries over `value` or `data`, even when the source node has a defensive `data.hName`', () => {
      const node = html('<br>', { data: { hName: 'br', hProperties: { className: ['x'] } } });
      const tree = root(paragraph(node));
      runTransform(tree);
      const replaced = (tree.children[0] as Paragraph).children[0] as Break;
      expect(replaced).toEqual({ type: 'break' });
    });

    it.each([
      'root',
      'blockquote',
      'listItem',
    ])('retains a bare `<br>` whose direct parent type is `%s` (flow position), even shallowly nested in an otherwise-clean unit', (parentType) => {
      // A synthetic (plugin-injected-shaped) parent nested one level
      // inside a `paragraph` unit — realistic mdast never nests these
      // types inside a paragraph, but D-4's rule is "direct parent type
      // only", so this proves the allow-list check does not special-case
      // depth.
      const syntheticParent = { type: parentType, children: [html('<br>')] } as unknown as PhrasingContent;
      const tree = root(paragraph(text('before'), syntheticParent, text('after')));
      runTransform(tree);
      const rewrapped = (tree.children[0] as Paragraph).children[1] as unknown as { type: string; children: PhrasingContent[] };
      expect(rewrapped.children).toEqual([html('<br>')]);
    });

    it('retains a bare `<br>` under an unrecognised (e.g. plugin-injected) parent type, at any depth', () => {
      // 3 levels of `strong` wrapping an unknown parent type wrapping the
      // `<br>` — the allow-list is direct-parent-only, so depth never
      // matters and an unmodelled parent type is never treated as allowed.
      const deep: PhrasingContent = {
        type: 'strong',
        children: [
          {
            type: 'strong',
            children: [
              {
                type: 'strong',
                children: [{ type: 'x-plugin-wrapper', children: [html('<br>')] } as unknown as PhrasingContent],
              } as unknown as PhrasingContent,
            ],
          } as unknown as PhrasingContent,
        ],
      } as unknown as PhrasingContent;
      const tree = root(paragraph(deep));
      runTransform(tree);
      const level1 = (tree.children[0] as Paragraph).children[0] as unknown as { children: PhrasingContent[] };
      const level2 = level1.children[0] as unknown as { children: PhrasingContent[] };
      const level3 = level2.children[0] as unknown as { children: PhrasingContent[] };
      const wrapper = level3.children[0] as unknown as { children: PhrasingContent[] };
      expect(wrapper.children).toEqual([html('<br>')]);
    });

    it.each([
      'paragraph',
      'heading',
      'emphasis',
      'strong',
      'delete',
      'link',
      'linkReference',
      'tableCell',
    ])('converts a bare `<br>` whose direct parent type is the allow-listed `%s`', (parentType) => {
      const parent = { type: parentType, children: [text('a'), html('<br>'), text('b')] } as unknown as PhrasingContent;
      const tree = root(paragraph(parent));
      runTransform(tree);
      const rewrapped = (tree.children[0] as Paragraph).children[0] as unknown as { children: PhrasingContent[] };
      expect(rewrapped.children).toEqual([text('a'), { type: 'break' }, text('b')]);
    });
  });

  describe('AC-4: unit-scope contamination — one non-bare `html` anywhere in the unit blocks every replacement in it', () => {
    it('retains every `<br>` when a non-bare `html` is a DIRECT sibling in the same unit', () => {
      const tree = root(paragraph(html('<span style="white-space:pre">'), text('x'), html('<br>'), text('y'), html('</span>')));
      const before = structuredClone(tree);
      runTransform(tree);
      expect(tree).toEqual(before);
    });

    it('retains every `<br>` when the non-bare `html` is only reachable through an inline wrapper (e.g. `strong`) — the sandwich case', () => {
      const tree = root(paragraph(html('<span style="white-space:pre">'), { type: 'strong', children: [text('x'), html('<br>'), text('y')] }, html('</span>')));
      const before = structuredClone(tree);
      runTransform(tree);
      expect(tree).toEqual(before);
    });
  });

  describe('uncontaminated units convert every bare `<br>` in their subtree', () => {
    it('converts both `<br>`s in a tableCell holding 2 breaks (`a<br>b<br>c`)', () => {
      const tree = root(tableCell(text('a'), html('<br>'), text('b'), html('<br>'), text('c')) as unknown as RootContent);
      runTransform(tree);
      expect((tree.children[0] as unknown as TableCell).children).toEqual([text('a'), { type: 'break' }, text('b'), { type: 'break' }, text('c')]);
    });

    it('two independent tableCell units — one contaminated, one clean — are each judged on their own subtree', () => {
      const contaminated = tableCell(html('<b>'), text('x'), html('</b>'));
      const clean = tableCell(text('a'), html('<br>'), text('b'));
      const tree = root({ type: 'tableRow', children: [contaminated, clean] } as unknown as RootContent);
      runTransform(tree);
      const row = tree.children[0] as unknown as { children: TableCell[] };
      expect(row.children[0].children).toEqual([html('<b>'), text('x'), html('</b>')]);
      expect(row.children[1].children).toEqual([text('a'), { type: 'break' }, text('b')]);
    });
  });

  describe('flow position is never touched (units are only paragraph/heading/tableCell)', () => {
    it('leaves a root-level flow `html("<br>")` untouched', () => {
      const tree = root(html('<br>'));
      runTransform(tree);
      expect(tree.children).toEqual([html('<br>')]);
    });
  });

  describe('AC-12: deep phrasing-parent chains — the shared `_mdast-walk.ts#walkPhrasingTree` walker, no bespoke walker', () => {
    // Deliberately NOT the largest depth that could ever be authored — the
    // shared walker is recursive (feature-renderer-break-normalization
    // AC-12 explicitly claims no call-stack-depth guarantee: `serialize.ts`
    // / `sanitize-ast.ts` / `core/headings.ts` all walk the same tree
    // recursively too, so hardening only this transform against a
    // pathological chain would not change whether an end-to-end request
    // survives one). This depth is far beyond any real Markdown document
    // (tens of levels of nested emphasis/strong/links) while staying safely
    // inside Node's default stack.
    const DEEP_CHAIN_LENGTH = 500;

    function buildChain(depth: number, innermost: PhrasingContent): PhrasingContent {
      let node = innermost;
      for (let i = 0; i < depth; i++) {
        node = { type: i % 2 === 0 ? 'strong' : 'emphasis', children: [node] } as unknown as PhrasingContent;
      }
      return node;
    }

    it(`converts a bare <br> at the bottom of a ${DEEP_CHAIN_LENGTH}-level strong/emphasis chain`, () => {
      const tree = root(paragraph(buildChain(DEEP_CHAIN_LENGTH, html('<br>'))));
      expect(() => runTransform(tree)).not.toThrow();

      let node: unknown = (tree.children[0] as Paragraph).children[0];
      for (let i = 0; i < DEEP_CHAIN_LENGTH; i++) {
        node = (node as { children: unknown[] }).children[0];
      }
      expect(node).toEqual({ type: 'break' });
    });
  });
});
