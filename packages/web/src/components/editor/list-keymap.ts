import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type ChangeSpec, type Text } from '@codemirror/state';
import { type Command, type KeyBinding } from '@codemirror/view';

/**
 * The lezer syntax-node shape returned by `Tree.resolveInner`. Derived
 * from `syntaxTree`'s return type so we don't add a direct dependency
 * on `@lezer/common` (it is only present transitively).
 */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/**
 * RFC-0005 — Markdown list editing keymap for the CodeMirror editor.
 *
 * `@codemirror/lang-markdown`'s built-in `insertNewlineContinueMarkup`
 * does two things we want to override or extend:
 *
 *  1. **Loose-list blank line (#1).** When the cursor sits in a list
 *     whose items are blank-line-separated (a "non-tight" list — e.g.
 *     a fresh `- z` typed on a line directly above an existing
 *     blank-line-separated list), the built-in mirrors that looseness
 *     by inserting `\n\n- ` instead of `\n- `. The user almost always
 *     wants a *tight* continuation (`\n- ` only). `continueListMarkup`
 *     handles the plain list-continuation case itself (tight), and
 *     delegates every other case (empty-item dedent, blockquotes,
 *     ordered renumbering across edits, lazy continuation lines) to
 *     the built-in command.
 *
 *  2. **Tab / Shift-Tab indent (#2).** The built-in keymap has no
 *     Tab binding. `indentListItem` / `dedentListItem` indent or
 *     dedent the current list item by one markdown nesting level
 *     (parent marker width, 2 spaces for `- `). Both return `false`
 *     when the cursor is *not* inside a list item so the editor's
 *     default Tab (focus move) is preserved — `indentWithTab` would
 *     trap focus and is intentionally not used.
 */

/** Climb to the nearest enclosing `ListItem` syntax node, or `null`. */
function enclosingListItem(node: SyntaxNode | null): SyntaxNode | null {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (cur.name === 'ListItem') return cur;
    // A FencedCode region uses its own language; never treat code as a list.
    if (cur.name === 'FencedCode') return null;
  }
  return null;
}

/** The `ListMark` child (`-`, `*`, `+`, `1.`) of a `ListItem`. */
function listMarkOf(item: SyntaxNode): SyntaxNode | null {
  return item.getChild('ListMark');
}

/**
 * Width of the list-item marker indentation: the columns from the
 * line start up to (and including) the whitespace after the
 * `ListMark`. For `- ` this is `2`; for `  - ` (nested) it is `4`;
 * for `1. ` it is `3`. Used as the per-level indent unit so Tab nests
 * a child item directly under its parent's content column.
 */
function markerWidth(doc: Text, item: SyntaxNode): number {
  const mark = listMarkOf(item);
  if (!mark) return 2;
  const line = doc.lineAt(item.from);
  // Marker end → first non-space after it = content column.
  const afterMark = mark.to - line.from;
  const rest = line.text.slice(afterMark);
  const space = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
  return afterMark + space;
}

/**
 * Enter handler that continues a markdown list item *tightly*.
 *
 * Returns `true` (and dispatches) only for the plain "continue the
 * current non-empty list item" case. For every other shape — empty
 * item (dedent / exit list), blockquote, the cursor not at end of the
 * item's text — it returns `false` so the caller's next Enter binding
 * (`insertNewlineContinueMarkup`) takes over with its full behaviour.
 */
export const continueListMarkup: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const pos = range.from;
  const tree = syntaxTree(state);
  const item = enclosingListItem(tree.resolveInner(pos, -1));
  if (!item) return false;

  const mark = listMarkOf(item);
  if (!mark) return false;

  const line = state.doc.lineAt(pos);
  const itemFirstLine = state.doc.lineAt(item.from);

  // Only handle a cursor on the item's first line, sitting at end of
  // line, with actual content after the marker. Multi-line items,
  // lazy continuation lines and empty items fall through to the
  // built-in command (which knows how to dedent / exit those).
  if (line.number !== itemFirstLine.number) return false;
  if (pos !== line.to) return false;

  const contentStart = mark.to + (/^[ \t]*/.exec(state.doc.sliceString(mark.to, line.to))?.[0].length ?? 0);
  // Empty item (`- ` with nothing after): let the built-in dedent /
  // exit the list rather than continuing it.
  if (pos <= contentStart) return false;

  // Tight continuation: leading indentation up to the marker, plus a
  // fresh marker. Ordered-list renumbering across the rest of the
  // document is intentionally left to `insertNewlineContinueMarkup`
  // for multi-line / mid-list edits; appending one item at the end of
  // an ordered list still needs the next number, which we derive from
  // the current marker.
  const indent = line.text.slice(0, mark.from - line.from);
  const markText = state.doc.sliceString(mark.from, mark.to);
  const spaceAfterMark = state.doc.sliceString(mark.to, contentStart) || ' ';

  let nextMarker: string;
  const orderedMatch = /^(\d+)([.)])$/.exec(markText);
  if (orderedMatch) {
    nextMarker = `${Number(orderedMatch[1]) + 1}${orderedMatch[2]}`;
  } else {
    nextMarker = markText;
  }

  const insert = `${state.lineBreak}${indent}${nextMarker}${spaceAfterMark}`;
  view.dispatch(
    state.update({
      changes: { from: pos, insert },
      selection: EditorSelection.cursor(pos + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** Indent the current list item by one nesting level (Tab). */
export const indentListItem: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const tree = syntaxTree(state);
  const item = enclosingListItem(tree.resolveInner(range.from, -1));
  // Not in a list — let the editor's default Tab (focus move) run.
  if (!item) return false;

  // Indent every line touched by the selection that belongs to a list
  // item, by inserting `width` spaces of its parent marker indent.
  const startLine = state.doc.lineAt(range.from);
  const width = markerWidth(state.doc, item);
  const pad = ' '.repeat(width);

  const changes: ChangeSpec[] = [];
  let line = startLine;
  while (line.from <= range.to) {
    changes.push({ from: line.from, insert: pad });
    if (line.to >= state.doc.length) break;
    line = state.doc.lineAt(line.to + 1);
  }

  view.dispatch(
    state.update({
      changes,
      selection: EditorSelection.range(range.from + width, range.to + width * changes.length),
      userEvent: 'input.indent',
    }),
  );
  return true;
};

/** Dedent the current list item by one nesting level (Shift-Tab). */
export const dedentListItem: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const tree = syntaxTree(state);
  const item = enclosingListItem(tree.resolveInner(range.from, -1));
  if (!item) return false;

  const width = markerWidth(state.doc, item);
  const startLine = state.doc.lineAt(range.from);

  const changes: ChangeSpec[] = [];
  let removedBeforeAnchor = 0;
  let removedTotal = 0;
  let line = startLine;
  while (line.from <= range.to) {
    const leading = /^[ \t]*/.exec(line.text)?.[0] ?? '';
    // Remove up to `width` leading whitespace columns (a tab counts
    // as one char but the markdown convention is space indent — we
    // strip whichever leading chars exist, capped at the unit).
    const remove = Math.min(width, leading.length);
    if (remove > 0) {
      changes.push({ from: line.from, to: line.from + remove });
      if (line.from <= range.from) removedBeforeAnchor += remove;
      removedTotal += remove;
    }
    if (line.to >= state.doc.length) break;
    line = state.doc.lineAt(line.to + 1);
  }
  // Nothing to dedent — still consume Tab so focus doesn't escape
  // (the cursor is inside a list, just at the outermost level).
  if (changes.length === 0) return true;

  view.dispatch(
    state.update({
      changes,
      selection: EditorSelection.range(Math.max(startLine.from, range.from - removedBeforeAnchor), Math.max(startLine.from, range.to - removedTotal)),
      userEvent: 'delete.dedent',
    }),
  );
  return true;
};

/**
 * Keymap for markdown list editing. `continueListMarkup` is tried
 * before `insertNewlineContinueMarkup` so the tight-continuation case
 * wins; the built-in still receives every case the tight handler
 * declines (empty-item dedent, blockquotes, multi-line items).
 *
 * Tab / Shift-Tab are list-conditional: `indentListItem` /
 * `dedentListItem` return `false` outside a list so the editor's
 * default Tab behaviour (focus move) is preserved — the editor never
 * traps keyboard focus.
 */
export const listKeymap: readonly KeyBinding[] = [
  { key: 'Enter', run: continueListMarkup },
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: dedentListItem },
];
