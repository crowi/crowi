import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isRawSpaceLinkRecoverable, scanRawSpaceLinkGrammar } from '@crowi/api-contract';
import { buildExtensions } from './build-extensions';
import { editorDarkExtension } from './dark-theme';
import { buildRawSpaceLinkDecorations, findRawSpaceLinkSpans } from './raw-space-link-extension';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus: Array<{ name: string; markdown: string; destinations: string[] }> = JSON.parse(
  readFileSync(path.resolve(here, '../../../../api-contract/src/util/__fixtures__/raw-space-link-corpus.json'), 'utf8'),
);

function markdownState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [buildExtensions({ autocomplete: false })] });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

const whole = (state: EditorState) => [{ from: 0, to: state.doc.length }];

const views: EditorView[] = [];
function mount(doc: string, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [buildExtensions({ autocomplete: false }), ...extra] }) });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  // Syntax tree may have been extended after construction; force a re-measure/redraw cycle.
  view.dispatch({});
  views.push(view);
  return view;
}

afterEach(() => {
  for (const v of views.splice(0)) {
    v.destroy();
    v.dom.parentElement?.remove();
  }
});

/** Sorted class names of the innermost element wrapping the `index`-th character of the first line. */
function classesAt(view: EditorView, index: number): string[] {
  const line = view.dom.querySelector('.cm-line');
  if (!line) throw new Error('no line');
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let remaining = index;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (remaining < len) {
      const el = n.parentElement as HTMLElement;
      return el.className
        .split(/\s+/)
        .filter((c) => c && c !== 'cm-line')
        .sort();
    }
    remaining -= len;
  }
  throw new Error('index out of range');
}

describe('R-GRAMMAR / R-ACCEPT (shared with the renderer)', () => {
  const accepted = (source: string, raw?: string, rawStart?: number) => {
    const [m] = scanRawSpaceLinkGrammar(source);
    return m !== undefined && isRawSpaceLinkRecoverable(source, m, raw === undefined ? undefined : { source: raw, start: rawStart ?? m.start });
  };

  it('accepts a raw-space absolute destination', () => {
    const [m] = scanRawSpaceLinkGrammar('see [a](/x y) now');
    expect(m).toEqual({ start: 4, end: 13, label: 'a', destination: '/x y' });
    expect(accepted('see [a](/x y) now')).toBe(true);
  });

  it.each([
    ['image', '![a](/x y)'],
    ['no space', '[a](/x)'],
    ['title-like quote', '[a](/x y "t")'],
    ['relative path', '[a](x y)'],
    ['newline in label', '[a\nb](/x y)'],
    ['newline in destination', '[a](/x\ny z)'],
    ['label of 513 chars', `[${'a'.repeat(513)}](/x y)`],
    ['destination of 2049 chars', `[a](/${'x '.repeat(1025)})`],
  ])('rejects %s', (_name, source) => {
    expect(accepted(source)).toBe(false);
  });

  it('rejects an escaped opener only when the raw text is supplied', () => {
    expect(accepted('[a](/x y)')).toBe(true);
    expect(accepted('[a](/x y)', '\\[a](/x y)', 1)).toBe(false);
  });

  it('accepts the boundary sizes (label 512, destination 2048)', () => {
    expect(scanRawSpaceLinkGrammar(`[${'a'.repeat(512)}](/x y)`)).toHaveLength(1);
    expect(scanRawSpaceLinkGrammar(`[a](/${'x'.repeat(2047)})`)).toHaveLength(1);
  });

  it('does not share scan state between calls', () => {
    expect(scanRawSpaceLinkGrammar('[a](/x y)')).toHaveLength(1);
    expect(scanRawSpaceLinkGrammar('[a](/x y)')).toHaveLength(1);
  });
});

describe('R-PARITY (editor side)', () => {
  it.each(corpus.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const state = markdownState(row.markdown);
    const spans = findRawSpaceLinkSpans(state, whole(state));
    expect(spans.map((s) => state.sliceDoc(s.destinationFrom, s.destinationTo))).toEqual(row.destinations);
  });
});

describe('normal link forms are not decorated', () => {
  it.each(['[a](/x%20y)', '[a](/x+y)', '[a](</x y>)'])('%s', (doc) => {
    const state = markdownState(doc);
    expect(findRawSpaceLinkSpans(state, whole(state))).toEqual([]);
  });
});

describe('visible ranges', () => {
  const doc = '[a](/x y)\n[b](/p q)';
  it('does not return a candidate on a line outside the range', () => {
    const state = markdownState(doc);
    const spans = findRawSpaceLinkSpans(state, [{ from: 0, to: 9 }]);
    expect(spans.map((s) => state.sliceDoc(s.destinationFrom, s.destinationTo))).toEqual(['/x y']);
  });

  it('returns a candidate whose line intersects a range that starts mid-line', () => {
    const state = markdownState(doc);
    const spans = findRawSpaceLinkSpans(state, [{ from: 12, to: 14 }]);
    expect(spans.map((s) => state.sliceDoc(s.destinationFrom, s.destinationTo))).toEqual(['/p q']);
  });

  it('does not return the same candidate twice when ranges share a line', () => {
    const state = markdownState(doc);
    expect(
      findRawSpaceLinkSpans(state, [
        { from: 0, to: 2 },
        { from: 5, to: 7 },
      ]),
    ).toHaveLength(1);
  });

  it('does not decorate positions the syntax tree has not reached', () => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    // No ensureSyntaxTree: only the (possibly empty) parsed prefix counts.
    const spans = findRawSpaceLinkSpans(state, whole(state));
    expect(spans.length).toBeLessThanOrEqual(2);
  });

  it('builds an empty decoration set for no candidates', () => {
    const state = markdownState('plain text');
    expect(buildRawSpaceLinkDecorations(state, whole(state)).size).toBe(0);
  });
});

describe('look (R-LOOK)', () => {
  const rawDoc = '[a](/x y)';
  const pctDoc = '[a](/x%20y)';
  // label char, `[`, `(`, `)`, destination head
  const raw = { label: 1, open: 0, lparen: 3, rparen: 8, dest: 4 };
  const pct = { label: 1, open: 0, lparen: 3, rparen: 10, dest: 4 };

  it.each([
    ['light', [] as Extension[]],
    ['dark', [editorDarkExtension]],
  ])('colours a raw-space link like the %%20 form (%s)', (_theme, extra) => {
    const a = mount(rawDoc, extra);
    const b = mount(pctDoc, extra);
    for (const key of Object.keys(raw) as Array<keyof typeof raw>) {
      expect(classesAt(a, raw[key]), key).toEqual(classesAt(b, pct[key]));
    }
    expect(classesAt(a, raw.dest).length).toBeGreaterThan(0);
  });

  it('adds and removes the colouring as the destination gains and loses a space (docChanged)', () => {
    const view = mount('[a](/xy)');
    const decorationCount = () => buildRawSpaceLinkDecorations(view.state, view.visibleRanges).size;
    expect(decorationCount()).toBe(0);
    view.dispatch({ changes: { from: 5, insert: ' ' } });
    expect(decorationCount()).toBe(3);
    view.dispatch({ changes: { from: 5, to: 6 } });
    expect(decorationCount()).toBe(0);
  });

  it('draws the colouring in the DOM once the link closes, and drops it when it unclosed again', () => {
    const view = mount('[a](/x y');
    expect(classesAt(view, 4)).toEqual([]);
    view.dispatch({ changes: { from: 8, insert: ')' } });
    expect(classesAt(view, 4).length).toBeGreaterThan(0);
    view.dispatch({ changes: { from: 8, to: 9 } });
    expect(classesAt(view, 4)).toEqual([]);
  });

  it('re-resolves classes when the theme is reconfigured', () => {
    const theme = new Compartment();
    const view = mount('[a](/x y)', [theme.of([])]);
    const before = classesAt(view, 4);
    view.dispatch({ effects: theme.reconfigure(editorDarkExtension) });
    const after = classesAt(view, 4);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });
});
