import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { continueListMarkup, dedentListItem, indentListItem } from './list-keymap';

/**
 * RFC-0005 — unit tests for the markdown list keymap commands.
 *
 * Each command is a CodeMirror `Command` (`(view) => boolean`) and only
 * touches `view.state` / `view.dispatch`. We drive them with a minimal
 * stub that owns an `EditorState` and applies dispatched transactions —
 * this avoids mounting a real `EditorView`, which would trigger
 * CodeMirror's layout-measure pass and crash under jsdom (no real
 * `getClientRects`). `ensureSyntaxTree` is called first so the markdown
 * lezer tree the commands resolve against is fully parsed.
 */
class StubView {
  state: EditorState;
  constructor(state: EditorState) {
    this.state = state;
  }
  dispatch(tr: Parameters<EditorState['update']>[0]) {
    this.state = this.state.update(tr).state;
  }
}

/** Build a stub view typed as `EditorView` for the command signature. */
function makeView(state: EditorState): EditorView {
  return new StubView(state) as unknown as EditorView;
}

function mountView(doc: string, cursorAt: number): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown()],
    selection: EditorSelection.cursor(cursorAt),
  });
  ensureSyntaxTree(state, doc.length);
  return makeView(state);
}

function mountViewRange(doc: string, from: number, to: number): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown()],
    selection: EditorSelection.range(from, to),
  });
  ensureSyntaxTree(state, doc.length);
  return makeView(state);
}

describe('continueListMarkup (#1 — tight list continuation)', () => {
  it('continues a bullet list tightly even when the list is loose (blank-line separated)', () => {
    // `- z` typed on the line directly above an existing blank-line-
    // separated list. The built-in `insertNewlineContinueMarkup` would
    // mirror the looseness and insert `\n\n- `; the tight command must
    // insert only `\n- `.
    const view = mountView('- z\n\n- x\n- y', 3);
    expect(continueListMarkup(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- z\n- \n\n- x\n- y');
    expect(view.state.selection.main.head).toBe(6);
  });

  it('continues a simple tight bullet list', () => {
    const view = mountView('- a', 3);
    expect(continueListMarkup(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n- ');
  });

  it('continues an ordered list with the next number', () => {
    const view = mountView('1. a\n2. b', 9);
    expect(continueListMarkup(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. ');
  });

  it('preserves the nesting indentation of a nested item', () => {
    const view = mountView('- a\n  - b', 9);
    expect(continueListMarkup(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n  - ');
  });

  it('declines an empty list item (lets the built-in dedent / exit handle it)', () => {
    // `- ` with no content after the marker: command returns false so
    // the next Enter binding (insertNewlineContinueMarkup) can dedent.
    const view = mountView('- a\n- ', 6);
    expect(continueListMarkup(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('- a\n- ');
  });

  it('declines when the cursor is not inside a list', () => {
    const view = mountView('plain paragraph', 5);
    expect(continueListMarkup(view)).toBe(false);
  });

  it('declines a non-empty selection', () => {
    const view = mountViewRange('- abc', 2, 4);
    expect(continueListMarkup(view)).toBe(false);
  });
});

describe('indentListItem / dedentListItem (#2 — Tab indent / unindent)', () => {
  it('indents a bullet list item by the parent marker width (2 spaces)', () => {
    const view = mountView('- a\n- b', 7);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b');
  });

  it('dedents a nested bullet list item back one level', () => {
    const view = mountView('- a\n  - b', 9);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n- b');
  });

  it('indent then dedent round-trips to the original document', () => {
    const view = mountView('- a\n- b', 7);
    indentListItem(view);
    dedentListItem(view);
    expect(view.state.doc.toString()).toBe('- a\n- b');
  });

  it('returns false outside a list so the editor default Tab is preserved', () => {
    const view = mountView('not a list', 4);
    expect(indentListItem(view)).toBe(false);
    expect(dedentListItem(view)).toBe(false);
  });

  it('dedent at the outermost list level consumes Tab without escaping focus', () => {
    // Already flush-left — nothing to remove, but the command still
    // returns true so Tab does not fall through to focus-move.
    const view = mountView('- a', 3);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a');
  });

  it('indents using the ordered-list marker width (3 columns for `1. `)', () => {
    const view = mountView('1. a\n2. b', 9);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. a\n   2. b');
  });
});
