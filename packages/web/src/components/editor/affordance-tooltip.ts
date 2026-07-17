import { type EditorState, type Extension, StateField } from '@codemirror/state';
import { closeHoverTooltips, EditorView, hoverTooltip, showTooltip, type Tooltip } from '@codemirror/view';

/**
 * Shared cursor+hover tooltip scaffolding for editor "affordances" — the
 * small action panels the image display-attribute affordance and the
 * link-card conversion affordance float over a markup span. Extracted
 * because the two extensions had byte-identical copies of the subtlest
 * plumbing in either file, all of which exists to fix real bugs:
 *
 *   - the cursor `StateField` keeps the previous `Tooltip` BY REFERENCE
 *     while it still describes the same span, so CodeMirror doesn't tear
 *     down the `TooltipView` (and the DOM mid-interaction) on unrelated
 *     transactions;
 *   - the hover source suppresses itself when the cursor trigger already
 *     covers the exact same span (the duplicate-tooltip fix — two
 *     triggers must never stack two panels over one target);
 *   - the update listener closes an already-open hover panel when the
 *     cursor trigger newly takes over the same span (the reverse-order
 *     path the hover source alone cannot catch), dispatched via
 *     `queueMicrotask` because an `updateListener` must not dispatch
 *     during the in-progress update.
 *
 * A caller supplies only `computeTooltip` (what to show, where) and its
 * own theme; everything timing-sensitive lives here exactly once.
 */

interface CursorTooltipState {
  tooltip: Tooltip | null;
}

/** True when two tooltips describe the exact same span (identical `pos` and `end`). */
export function sameSpan(a: Tooltip, b: Tooltip): boolean {
  return a.pos === b.pos && a.end === b.end;
}

export interface AffordanceTooltipHandle {
  /** The cursor field + hover trigger + take-over convergence listener, ready to spread into an extension array (theme NOT included — each affordance owns its own). */
  extension: Extension;
  /** The hover trigger's source function, exported so each affordance can re-export it for direct unit testing of the same-span suppression. */
  hoverSource: (view: EditorView, pos: number) => Tooltip | null;
}

export function createAffordanceTooltip(
  computeTooltip: (state: EditorState, pos: number) => Tooltip | null,
  { hoverTime = 300 } = {},
): AffordanceTooltipHandle {
  const cursorField = StateField.define<CursorTooltipState>({
    create(state) {
      return { tooltip: computeTooltip(state, state.selection.main.head) };
    },
    update(value, tr) {
      const next = computeTooltip(tr.state, tr.state.selection.main.head);
      if (value.tooltip && next && sameSpan(value.tooltip, next)) {
        return value;
      }
      return { tooltip: next };
    },
    provide: (field) => showTooltip.from(field, (value) => value.tooltip),
  });

  const hoverSource = (view: EditorView, pos: number): Tooltip | null => {
    const hover = computeTooltip(view.state, pos);
    if (!hover) return null;
    const cursor = view.state.field(cursorField).tooltip;
    if (cursor && sameSpan(cursor, hover)) return null;
    return hover;
  };

  const hover = hoverTooltip(hoverSource, { hoverTime });

  const closeHoverWhenCursorTakesOver = EditorView.updateListener.of((update) => {
    const prev = update.startState.field(cursorField).tooltip;
    const next = update.state.field(cursorField).tooltip;
    if (!next) return;
    if (prev && sameSpan(prev, next)) return; // caret still on the same span — nothing newly appeared.
    const hoverOverlaps = update.state.field(hover.active).some((t) => sameSpan(t, next));
    if (!hoverOverlaps) return;
    queueMicrotask(() => update.view.dispatch({ effects: closeHoverTooltips }));
  });

  return { extension: [cursorField, hover, closeHoverWhenCursorTakesOver], hoverSource };
}
