import type { Blockquote, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';
import { createEmptyPipelineMetadata } from '../pipeline';
import { type CrowiAlertVariant, GITHUB_ALERT_MARKER_LINE_RE, GITHUB_ALERT_VARIANTS, makeGithubAlertsPlugin } from './github-alerts';

/**
 * Isolated unit coverage of the transform itself (the real-parser
 * end-to-end cases live in `pipeline.test.ts`). Every case pairs a raw
 * `body` string with a synthetic tree whose block quote `position`
 * points into it — the transform's recognition authority is that raw
 * source, so a synthetic-only tree would prove nothing.
 */

function runTransform(tree: Root, body: string): void {
  makeGithubAlertsPlugin(body)(createEmptyPipelineMetadata())(tree);
}

const text = (value: string): PhrasingContent => ({ type: 'text', value });
const paragraph = (...children: PhrasingContent[]): Paragraph => ({ type: 'paragraph', children });

/** A block quote whose source starts at `offset` in the paired raw body. */
function blockquote(offset: number, ...children: Blockquote['children']): Blockquote {
  return {
    type: 'blockquote',
    children,
    position: { start: { line: 1, column: 1, offset }, end: { line: 1, column: 1, offset: offset + 1 } },
  };
}

function root(...children: RootContent[]): Root {
  return { type: 'root', children };
}

type AlertOut = { type: string; variant?: string; children: RootContent[]; data?: Record<string, unknown>; position?: unknown };

const asAlert = (node: RootContent): AlertOut => node as unknown as AlertOut;

/** The canonical two-line shape: `> [!X]` + a body line, which the parser leaves as ONE text node with a soft line break. */
function canonical(variant: string): { body: string; tree: Root; quote: Blockquote } {
  const body = `> [!${variant}]\n> body\n`;
  const quote = blockquote(0, paragraph(text(`[!${variant}]\nbody`)));
  return { body, tree: root(quote), quote };
}

describe('core/github-alerts transform', () => {
  describe('recognition', () => {
    it.each(GITHUB_ALERT_VARIANTS)('converts the canonical `> [!%s]` marker to a lowercase-variant crowiAlert', (variant) => {
      const { body, tree } = canonical(variant.toUpperCase());
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.type).toBe('crowiAlert');
      expect(alert.variant).toBe(variant);
    });

    it.each([
      ['note', '[!note]'],
      ['tip', '[!Tip]'],
      ['important', '[!ImPoRtAnT]'],
    ] as const)('accepts ASCII case-insensitively and normalises the variant to %s', (expected, spelling) => {
      const body = `> ${spelling}\n> body\n`;
      const tree = root(blockquote(0, paragraph(text(`${spelling}\nbody`))));
      runTransform(tree, body);
      expect(asAlert(tree.children[0]).variant).toBe(expected);
    });

    it('keeps the original children — marker text included — as the very same node objects', () => {
      const { body, tree, quote } = canonical('NOTE');
      const originalChildren = quote.children;
      const originalFirst = quote.children[0];
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.children).toBe(originalChildren);
      expect(alert.children[0]).toBe(originalFirst);
      expect((alert.children[0] as Paragraph).children[0]).toEqual({ type: 'text', value: '[!NOTE]\nbody' });
    });

    it('stamps the fixed `data.hName: blockquote` wire hint and copies the source position', () => {
      const { body, tree, quote } = canonical('WARNING');
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.data).toEqual({ hName: 'blockquote' });
      expect(alert.position).toBe(quote.position);
    });

    it('merges the fixed hName over an existing `data` instead of dropping it', () => {
      const body = '> [!TIP]\n> body\n';
      const quote = blockquote(0, paragraph(text('[!TIP]\nbody')));
      quote.data = { hProperties: { 'data-source-line': 1 }, hName: 'section' };
      const tree = root(quote);
      runTransform(tree, body);
      const alert = asAlert(tree.children[0]);
      expect(alert.data).toEqual({ hProperties: { 'data-source-line': 1 }, hName: 'blockquote' });
    });

    it('leaves a non-blockquote root child untouched', () => {
      const p = paragraph(text('[!NOTE]'));
      const tree = root(p);
      runTransform(tree, '[!NOTE]\n');
      expect(tree.children[0]).toBe(p);
    });
  });

  describe('raw-source boundary', () => {
    const rejected: Array<[string, string, string]> = [
      ['an unknown token', '> [!HINT]\n> body\n', '[!HINT]\nbody'],
      ['marker and body on the same line', '> [!NOTE] body\n', '[!NOTE] body'],
      ['a backslash-escaped opening bracket', '> \\[!NOTE]\n> body\n', '[!NOTE]\nbody'],
      ['an entity-encoded opening bracket', '> &#91;!NOTE]\n> body\n', '[!NOTE]\nbody'],
      ['a marker preceded by other text on the line', '> x [!NOTE]\n> body\n', 'x [!NOTE]\nbody'],
    ];

    it.each(rejected)('keeps the ordinary blockquote for %s', (_label, body, value) => {
      const quote = blockquote(0, paragraph(text(value)));
      const tree = root(quote);
      runTransform(tree, body);
      expect(tree.children[0]).toBe(quote);
      expect(tree.children[0].type).toBe('blockquote');
    });

    it('rejects a marker line that ends the document with no line terminator', () => {
      const quote = blockquote(0, paragraph(text('[!NOTE]')), paragraph(text('body')));
      const tree = root(quote);
      runTransform(tree, '> [!NOTE]');
      expect(tree.children[0]).toBe(quote);
    });

    it('accepts GitHub-compatible whitespace after `>` and at the end of the marker line', () => {
      const body = '>\t  [!NOTE] \t\n> body\n';
      const tree = root(blockquote(0, paragraph(text('[!NOTE]\nbody'))));
      runTransform(tree, body);
      expect(asAlert(tree.children[0]).type).toBe('crowiAlert');
    });

    it('accepts a CRLF marker line', () => {
      const body = '> [!CAUTION]\r\n> body\r\n';
      const tree = root(blockquote(0, paragraph(text('[!CAUTION]\nbody'))));
      runTransform(tree, body);
      expect(asAlert(tree.children[0]).variant).toBe('caution');
    });

    it("reads the raw line at the quote's own offset, not at the start of the document", () => {
      const body = 'intro\n\n> [!IMPORTANT]\n> body\n';
      const tree = root(paragraph(text('intro')), blockquote(body.indexOf('>'), paragraph(text('[!IMPORTANT]\nbody'))));
      runTransform(tree, body);
      expect(asAlert(tree.children[1]).variant).toBe('important');
    });

    it('rejects a candidate with no position at all (nothing to check the raw source against)', () => {
      const quote: Blockquote = { type: 'blockquote', children: [paragraph(text('[!NOTE]\nbody'))] };
      const tree = root(quote);
      runTransform(tree, '> [!NOTE]\n> body\n');
      expect(tree.children[0]).toBe(quote);
    });

    it('rejects when the parsed marker token disagrees with the raw line', () => {
      // Raw source says NOTE, but the parser handed back a different
      // token — a shape only a preceding transform could produce, and
      // never something to promote on the raw line alone.
      const tree = root(blockquote(0, paragraph(text('[!TIP]\nbody'))));
      runTransform(tree, '> [!NOTE]\n> body\n');
      expect(tree.children[0].type).toBe('blockquote');
    });
  });

  describe('body preservation', () => {
    it('keeps the marker remainder, phrasing siblings and their order untouched', () => {
      const body = '> [!NOTE]\n> see [x](/a), *y* and ![i](/i.png)\n';
      const link: PhrasingContent = { type: 'link', url: '/a', title: null, children: [text('x')] };
      const emphasis: PhrasingContent = { type: 'emphasis', children: [text('y')] };
      const image: PhrasingContent = { type: 'image', url: '/i.png', title: null, alt: 'i' };
      const p = paragraph(text('[!NOTE]\nsee '), link, text(', '), emphasis, text(' and '), image);
      const tree = root(blockquote(0, p));
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.children[0]).toBe(p);
      const children = (alert.children[0] as Paragraph).children;
      expect(children).toEqual([text('[!NOTE]\nsee '), link, text(', '), emphasis, text(' and '), image]);
      // Same objects, not equal copies: a rebuilt subtree would lose the
      // `position` the later raw-source transforms slice the body by.
      expect(children[1]).toBe(link);
      expect(children[3]).toBe(emphasis);
      expect(children[5]).toBe(image);
    });

    it('keeps every following flow block in order', () => {
      const body = '> [!TIP]\n>\n> para\n>\n> - item\n';
      const markerPara = paragraph(text('[!TIP]'));
      const bodyPara = paragraph(text('para'));
      const list: RootContent = {
        type: 'list',
        ordered: false,
        spread: false,
        children: [{ type: 'listItem', spread: false, checked: null, children: [paragraph(text('item'))] }],
      };
      const tree = root(blockquote(0, markerPara, bodyPara, list));
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.children).toEqual([markerPara, bodyPara, list]);
    });

    it('treats the `break` right after a hard-break marker line as the delimiter, not as the body', () => {
      // `> [!NOTE]··` (two trailing spaces) — the parser produces a
      // `break` node, and the body after it is what makes this an alert.
      const body = '> [!NOTE]  \n> body\n';
      const tree = root(blockquote(0, paragraph(text('[!NOTE]'), { type: 'break' }, text('body'))));
      runTransform(tree, body);
      expect(asAlert(tree.children[0]).type).toBe('crowiAlert');
    });
  });

  describe('renderable body', () => {
    const unconverted: Array<[string, Blockquote['children']]> = [
      ['marker only', [paragraph(text('[!NOTE]'))]],
      ['marker plus a hard break with nothing after it', [paragraph(text('[!NOTE]'), { type: 'break' })]],
      ['marker plus whitespace only', [paragraph(text('[!NOTE]\n   '))]],
      ['definition only', [paragraph(text('[!NOTE]')), { type: 'definition', identifier: 'a', label: 'a', url: '/a', title: null }]],
      ['footnoteDefinition only', [paragraph(text('[!NOTE]')), { type: 'footnoteDefinition', identifier: 'f', label: 'f', children: [] }]],
      ['an HTML comment only', [paragraph(text('[!NOTE]')), { type: 'html', value: '<!-- nothing paints this -->' }]],
    ];

    it.each(unconverted)('leaves the quote alone when the body is %s', (_label, children) => {
      const quote = blockquote(0, ...children);
      const tree = root(quote);
      runTransform(tree, '> [!NOTE]\n');
      expect(tree.children[0]).toBe(quote);
    });

    it('converts when a renderable paragraph follows the non-renderable nodes', () => {
      const quote = blockquote(
        0,
        paragraph(text('[!NOTE]')),
        { type: 'definition', identifier: 'a', label: 'a', url: '/a', title: null },
        paragraph(text('body')),
      );
      const tree = root(quote);
      runTransform(tree, '> [!NOTE]\n');
      expect(asAlert(tree.children[0]).type).toBe('crowiAlert');
    });

    it('converts when the marker paragraph itself carries a renderable sibling', () => {
      const image: PhrasingContent = { type: 'image', url: '/i.png', title: null, alt: 'i' };
      const tree = root(blockquote(0, paragraph(text('[!NOTE]'), { type: 'break' }, image)));
      runTransform(tree, '> [!NOTE]\n');
      expect(asAlert(tree.children[0]).type).toBe('crowiAlert');
    });
  });

  describe('placement', () => {
    it('never descends into a list item', () => {
      const inner = blockquote(0, paragraph(text('[!NOTE]\nbody')));
      const list: RootContent = {
        type: 'list',
        ordered: false,
        spread: false,
        children: [{ type: 'listItem', spread: false, checked: null, children: [inner] }],
      };
      const tree = root(list);
      runTransform(tree, '- > [!NOTE]\n  > body\n');
      expect(((tree.children[0] as typeof list).children[0].children[0] as Blockquote).type).toBe('blockquote');
    });

    it('never descends into a nested blockquote (the outer one is not a marker quote)', () => {
      const inner = blockquote(2, paragraph(text('[!NOTE]\nbody')));
      const outer = blockquote(0, inner);
      const tree = root(outer);
      runTransform(tree, '> > [!NOTE]\n> > body\n');
      expect(tree.children[0]).toBe(outer);
      expect(outer.children[0]).toBe(inner);
      expect(inner.type).toBe('blockquote');
    });

    it('never descends into an alert another run already produced', () => {
      // Only a re-run over an already-transformed tree can produce this,
      // and the interior marker must stay literal there too.
      const body = '> [!NOTE]\n>\n> > [!TIP]\n> > inner\n';
      const inner = blockquote(body.indexOf('> > [!TIP]') + 2, paragraph(text('[!TIP]\ninner')));
      const existing = {
        type: 'crowiAlert',
        variant: 'note',
        data: { hName: 'blockquote' },
        children: [paragraph(text('[!NOTE]')), inner],
        position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 4, column: 1, offset: body.length } },
      } as unknown as RootContent;
      const tree = root(existing);
      runTransform(tree, body);

      expect(tree.children[0]).toBe(existing);
      expect(asAlert(tree.children[0]).children[1]).toBe(inner);
      expect(inner.type).toBe('blockquote');
      expect(inner.children[0]).toEqual(paragraph(text('[!TIP]\ninner')));
    });

    it('keeps a nested ordinary blockquote inside an alert body as nested content', () => {
      const body = '> [!NOTE]\n>\n> > quoted\n';
      const nested = blockquote(body.indexOf('> > quoted') + 2, paragraph(text('quoted')));
      const tree = root(blockquote(0, paragraph(text('[!NOTE]')), nested));
      runTransform(tree, body);

      const alert = asAlert(tree.children[0]);
      expect(alert.type).toBe('crowiAlert');
      expect(alert.children[1]).toBe(nested);
      expect(nested.type).toBe('blockquote');
    });

    it('converts several sibling alerts independently and leaves everything between them alone', () => {
      const body = '> [!NOTE]\n> a\n\ntext\n\n> [!CAUTION]\n> b\n';
      const between = paragraph(text('text'));
      const tree = root(blockquote(0, paragraph(text('[!NOTE]\na'))), between, blockquote(body.indexOf('> [!CAUTION]'), paragraph(text('[!CAUTION]\nb'))));
      runTransform(tree, body);

      expect(tree.children.map((c) => c.type)).toEqual(['crowiAlert', 'paragraph', 'crowiAlert']);
      expect(tree.children[1]).toBe(between);
      expect(asAlert(tree.children[2]).variant).toBe('caution');
    });
  });

  it('never mutates the input subtree on the rejection path', () => {
    const p = paragraph(text('[!HINT]\nbody'));
    const quote = blockquote(0, p);
    const snapshot = structuredClone(quote);
    const tree = root(quote);
    runTransform(tree, '> [!HINT]\n> body\n');
    expect(quote).toEqual(snapshot);
    expect(tree.children[0]).toBe(quote);
  });

  it('recognises with a stateless matcher — no cross-request `lastIndex` to carry', () => {
    // A `g`/`y` matcher resumes from wherever the previous run left off:
    // shared across concurrent pipeline runs, that turns recognition
    // into a function of what someone else's document did last.
    expect(GITHUB_ALERT_MARKER_LINE_RE.global).toBe(false);
    expect(GITHUB_ALERT_MARKER_LINE_RE.sticky).toBe(false);

    const { body, tree } = canonical('NOTE');
    GITHUB_ALERT_MARKER_LINE_RE.lastIndex = 999;
    runTransform(tree, body);
    expect(asAlert(tree.children[0]).type).toBe('crowiAlert');
    expect(GITHUB_ALERT_MARKER_LINE_RE.lastIndex).toBe(999);
  });

  it('exposes exactly the five GitHub variants', () => {
    const variants: readonly CrowiAlertVariant[] = GITHUB_ALERT_VARIANTS;
    expect(variants).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
  });
});
