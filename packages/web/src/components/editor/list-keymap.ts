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
 *     dedent the current list item by one markdown nesting level — a
 *     level-independent unit (2 spaces for `- `, 3 for `1. `) taken
 *     from the reference item's own marker width, not the current
 *     item's (see `indentReferenceItem` / `parentListItem` below).
 *     Both return `false` when the cursor is *not* inside a list item
 *     so the editor's default Tab (focus move) is preserved —
 *     `indentWithTab` would trap focus and is intentionally not used.
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
 * Width of a single list-item marker: the marker's own glyph width
 * plus the whitespace after it, measured from the marker's own start
 * (`mark.from`) — not from the line start. For `- ` this is `2`; for
 * `1. ` it is `3`. This is a level-independent constant per marker
 * kind/digit-count: it does *not* grow with the item's existing
 * indentation, so it is safe to use as the one-nesting-level indent
 * unit regardless of how deeply the item is already nested.
 */
function markerWidth(doc: Text, item: SyntaxNode): number {
  const mark = listMarkOf(item);
  if (!mark) return 2;
  const line = doc.lineAt(item.from);
  const rest = line.text.slice(mark.to - line.from);
  const space = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
  return mark.to - mark.from + space;
}

/** `item`'s enclosing `ListItem` (the list item it is nested under), if any — the dedent unit's reference item. */
function parentListItem(item: SyntaxNode): SyntaxNode | null {
  const list = item.parent; // the List (Bullet/Ordered) that directly contains `item`
  const container = list?.parent ?? null;
  return container?.name === 'ListItem' ? container : null;
}

/**
 * The item whose marker width should be used as the indent unit when
 * Tab nests `item` one level deeper. Priority:
 *
 *  1. The previous sibling `ListItem` in the same list (the usual
 *     case: `- a` / `- b`, Tab on `b` nests it under `a` — same-depth
 *     homogeneous lists all take this branch and get the same width
 *     `item` itself used to report).
 *  2. If `item` is the first item of its list, and that list directly
 *     follows (no blank line between) a different list (marker kind
 *     changed mid-document — the bug1b Tab repro), the last item of
 *     that preceding list.
 *  3. Otherwise `item` itself (an already-isolated nested item being
 *     indented one level further — the core bug1 repro, where the
 *     depth-independent width of `item` itself is already correct).
 */
function indentReferenceItem(doc: Text, item: SyntaxNode): SyntaxNode {
  const prevItem = item.prevSibling;
  if (prevItem?.name === 'ListItem') return prevItem;

  const list = item.parent;
  const prevList = list?.prevSibling ?? null;
  const noBlankLineBetween = list != null && prevList != null && doc.lineAt(prevList.to).number + 1 === doc.lineAt(list.from).number;
  if (prevItem == null && prevList && (prevList.name === 'BulletList' || prevList.name === 'OrderedList') && noBlankLineBetween) {
    const lastItem = prevList.lastChild;
    if (lastItem?.name === 'ListItem') return lastItem;
  }
  return item;
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
  if (state.readOnly) return false;
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
    // Appending one item at the end of an ordered list only needs the
    // next number, derived from the current marker (handled here). A
    // mid-list item (one with a following sibling `ListItem`) instead
    // needs every item after it renumbered — that's the built-in
    // `insertNewlineContinueMarkup`'s job (see the doc comment above),
    // so decline and let it fall through rather than inserting a
    // duplicate number ourselves.
    if (item.nextSibling?.name === 'ListItem') return false;
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
  if (state.readOnly) return false;
  const range = state.selection.main;
  const tree = syntaxTree(state);
  const item = enclosingListItem(tree.resolveInner(range.from, -1));
  // Not in a list — let the editor's default Tab (focus move) run.
  if (!item) return false;

  // Indent every line touched by the selection that belongs to a list
  // item, by inserting `width` spaces — the marker width of the item
  // `item` is about to nest under (see `indentReferenceItem`), not
  // `item`'s own marker width.
  const startLine = state.doc.lineAt(range.from);
  const width = markerWidth(state.doc, indentReferenceItem(state.doc, item));
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
  if (state.readOnly) return false;
  const range = state.selection.main;
  const tree = syntaxTree(state);
  const item = enclosingListItem(tree.resolveInner(range.from, -1));
  if (!item) return false;

  // Dedent by the marker width of the parent item `item` is actually
  // nested under (see `parentListItem`), not `item`'s own marker
  // width — the two can differ when marker kinds/digit-counts mix.
  const width = markerWidth(state.doc, parentListItem(item) ?? item);
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
  // `insertNewlineContinueMarkup` (`@codemirror/lang-markdown`) does not
  // guard `state.readOnly` itself, unlike every `@codemirror/commands`
  // editing command — wrap it so readonly editors stay a no-op here too
  // (falls through to `defaultKeymap`'s readonly-guarded Enter).
  { key: 'Enter', run: (view) => (view.state.readOnly ? false : insertNewlineContinueMarkup(view)) },
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: dedentListItem },
];
