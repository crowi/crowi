import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { continueListMarkup, dedentListItem, indentListItem, listKeymap } from './list-keymap';

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

  it('declines a mid-list ordered item (has a following sibling) so the built-in renumbering fallback runs instead', () => {
    // `2. b` is not the last item of its list (`3. c` follows) — inserting
    // `3. ` here ourselves would duplicate the existing `3. c`'s number.
    // Delegate to `insertNewlineContinueMarkup`, which renumbers the rest
    // of the list (verified end-to-end via a real EditorView in
    // MarkdownEditor.test.tsx).
    const doc = '1. a\n2. b\n3. c';
    const view = mountView(doc, doc.indexOf('b') + 1);
    expect(continueListMarkup(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
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

  it('indents an already-nested single-digit ordered item by the same 3-column width, independent of depth (AC: ordered marker Tab depth-independence)', () => {
    // `2. c` is already nested one level under `1. a` (via the `1. b`
    // sibling list). Tab must add exactly 3 columns — the same unit as
    // the level-0 case above — not a wider amount derived from the
    // existing 3-space indentation.
    const doc = '1. a\n   1. b\n   2. c';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. a\n   1. b\n      2. c');
  });
});

describe('markerWidth is level-independent (bug1 — indent width no longer grows with existing nesting)', () => {
  it('indents an already-nested bullet item by exactly one marker width (2), not the old bug — content col + 2', () => {
    // The headline bug1 repro: `- a\n  - b` (b already nested one level
    // under a). The pre-fix `markerWidth` measured from the line start
    // (including the 2-space existing indent) and produced `- a\n      - b`
    // (6 spaces = existing 4 + wrong unit 2... historically it compounded
    // to +4). The fix must add exactly 2, landing on 4 total.
    const doc = '- a\n  - b';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n    - b');
  });

  it('adds the same +2 at depth 2 as at depth 1 — the indent unit does not depend on depth (AC: depth-independence, isolated-nesting fallback branch)', () => {
    const doc = '- a\n  - b\n    - c';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n      - c');
  });

  it('dedents a depth-2 nested item by exactly one marker width (2), landing back at depth 1', () => {
    const doc = '- a\n  - b\n      - c'; // c correctly nested two levels under a (parent b's marker width = 2)
    const view = mountView(doc, doc.length);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n    - c');
  });

  it('indent then dedent round-trips at depth 2 (AC: Tab/Shift-Tab round-trip at nested depth)', () => {
    const doc = '- a\n  - b\n    - c';
    const view = mountView(doc, doc.length);
    indentListItem(view);
    dedentListItem(view);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('indentReferenceItem / parentListItem (bug1b — mixed marker kinds and ordered digit-count boundaries)', () => {
  it('Tab: an ordered parent + not-yet-nested bullet child indents by the parent marker width (3), not the child’s own (2)', () => {
    const doc = '1. parent\n- child';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. parent\n   - child');
  });

  it('Shift-Tab: a bullet child actually nested under an ordered parent dedents by the parent marker width (3), fully flattening', () => {
    const doc = '1. parent\n   - child';
    const view = mountView(doc, doc.length);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. parent\n- child');
  });

  it('Tab: an ordered-list digit-count boundary (`10.` parent, `9.` not-yet-nested child) indents by the parent width (4)', () => {
    const doc = '10. parent\n9. child';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('10. parent\n    9. child');
  });

  it('Shift-Tab: a `9.` child nested under a `10.` parent dedents by the parent width (4), leaving no remainder', () => {
    const doc = '10. parent\n    9. child';
    const view = mountView(doc, doc.length);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('10. parent\n9. child');
  });

  it('Tab: a blank line between two adjacent lists guards against treating them as nesting — falls back to the item’s own marker width', () => {
    // `- unrelated` is a separate top-level list, not a continuation of
    // `1. parent`'s list — the blank line must prevent indentReferenceItem
    // from picking the ordered parent's width (3) here.
    const doc = '1. parent\n\n- unrelated';
    const view = mountView(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('1. parent\n\n  - unrelated');
  });
});

describe('listKeymap structure (bug2 — no new Backspace binding, 4-entry shape preserved)', () => {
  it('has exactly the 4 documented entries (Enter continuation, Enter fallback, Tab, Shift-Tab) and no Backspace entry', () => {
    expect(listKeymap).toHaveLength(4);
    expect(listKeymap.map((b) => b.key)).toEqual(['Enter', 'Enter', 'Tab', 'Shift-Tab']);
    expect(listKeymap.some((b) => b.key === 'Backspace')).toBe(false);
  });
});
