/**
 * Keeping the current node visible in the sidebar rail.
 *
 * The rail is a fixed-height scroller, and a `YYYY/MM/` node opens every
 * day of the month at once (see `dateMonthPath`), so the tree routinely
 * runs longer than the rail is tall. Without this the node you are on can
 * render outside the visible slice, which reads as "the sidebar lost me".
 */

/** Marks the scrollable rail so the tree inside it can find its scroller. */
export const SIDEBAR_SCROLLER_ATTR = 'data-sidebar-scroller';

/** The vertical extent of a row or the viewport it scrolls inside. */
export interface ScrollBox {
  top: number;
  bottom: number;
  height: number;
}

/**
 * How far to move `view`'s `scrollTop` to centre `row` in it, or `0` when
 * `row` is already fully visible — an off-screen row is worth a jump, a
 * merely off-centre one is not.
 *
 * Both boxes are viewport-relative (`getBoundingClientRect`), so the
 * result is a delta to add to the current `scrollTop`, not an absolute
 * position. Overshooting either end is harmless: the browser clamps
 * `scrollTop` to the scrollable range.
 */
export function scrollOffsetToCenter(row: ScrollBox, view: ScrollBox): number {
  if (row.top >= view.top && row.bottom <= view.bottom) return 0;
  return row.top - view.top - (view.height - row.height) / 2;
}
