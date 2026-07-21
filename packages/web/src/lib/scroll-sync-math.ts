/**
 * Pure, DOM-free math for the editor↔preview "sliding reference" scroll
 * sync. Extracted out of `use-scroll-sync.ts` so the numeric core (progress
 * calculation, target scrollTop derivation, endpoint pinning, clamping) can
 * be unit-tested without mounting CodeMirror or the preview DOM.
 *
 * Design (see `.feature-state/specs/feature-scroll-sync-sliding-reference.md`
 * "設計の主な判断"): rather than always aligning the mapped line at the
 * viewport TOP on both panes, the alignment height slides continuously from
 * the top (progress `p=0`) to the bottom (`p=1`) of the DRIVING pane's own
 * viewport as that pane's scroll progress advances. This keeps the preview's
 * freshly-rendered bottom visible while appending at the end of a long
 * document, without the discrete "jump" a hard top/bottom zone switch would
 * cause.
 */

/**
 * Distance from a scroll-progress endpoint (`0` or `1`) inside which the
 * sliding reference PINS exactly at that endpoint's scrollTop instead of
 * relying on the interpolated anchor position. Anchors
 * (`[data-source-line]`) can be sparse near the start/end of a document, so
 * without this the last stretch of scroll wouldn't reliably reach the true
 * top/bottom — pinning removes that dependency on interpolation precision.
 */
export const SLIDING_REFERENCE_EPSILON = 0.001;

/** `true` once `progress` is close enough to `0` to pin at the start. */
export function isProgressNearStart(progress: number): boolean {
  return progress <= SLIDING_REFERENCE_EPSILON;
}

/** `true` once `progress` is close enough to `1` to pin at the end. */
export function isProgressNearEnd(progress: number): boolean {
  return progress >= 1 - SLIDING_REFERENCE_EPSILON;
}

/**
 * `0..1` scroll progress of a scrollable pane. Degenerates to `0` — the
 * legacy top-aligned behaviour — when the pane can't scroll at all
 * (`scrollHeight <= clientHeight`), so short documents never divide by a
 * non-positive range.
 */
export function computeScrollProgress(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= 0) return 0;
  return Math.max(0, Math.min(1, scrollTop / maxScroll));
}

export interface SlidingReferenceTargetInput {
  /** `0..1` scroll progress of the pane driving this sync (the "source"). */
  sourceProgress: number;
  /**
   * Content-space y of the reference point in the TARGET pane — i.e. the y
   * it would have if the target pane's `scrollTop` were `0` (so it stays
   * valid across scroll positions). `null` when it couldn't be resolved yet
   * (e.g. the preview has no anchors) — the caller should leave the target
   * pane's scroll position untouched, signalled here by also returning
   * `null`, UNLESS `sourceProgress` is pinned (an endpoint never needs a
   * reference point).
   */
  referenceY: number | null;
  /** Target pane's viewport (client) height, in px. */
  targetViewportHeight: number;
  /** Target pane's maximum scrollTop (`scrollHeight - clientHeight`, floored at `0`). */
  targetMaxScroll: number;
}

export interface DensityCompensatedReferenceTargetInput {
  /** `0..1` scroll progress of the pane driving this sync. */
  sourceProgress: number;
  /** Content-space y of the source viewport's top edge in the target pane. */
  topReferenceY: number | null;
  /** Content-space y of the source viewport's bottom edge in the target pane. */
  bottomReferenceY: number | null;
  /** Target pane's viewport (client) height, in px. */
  targetViewportHeight: number;
  /** Target pane's maximum scrollTop (`scrollHeight - clientHeight`, floored at `0`). */
  targetMaxScroll: number;
}

/**
 * Sliding-reference target `scrollTop` for the pane opposite
 * `sourceProgress`: places the reference point at the SAME viewport-height
 * fraction the source pane is currently scrolled to, so `p=0` aligns both
 * panes' tops, `p=1` aligns both bottoms, and intermediate positions align
 * at the same proportional height — continuously, not as a discrete zone
 * switch. `computeDensityCompensatedReferenceTarget` applies the same
 * baseline while reserving additional trailing room for denser previews.
 *
 * The two ends are pinned exactly (bypassing `referenceY` entirely, see
 * `SLIDING_REFERENCE_EPSILON`) so a document with anchors sparse near an
 * edge still reaches the true top/bottom instead of depending on
 * interpolation precision. Interior results are clamped into
 * `[0, targetMaxScroll]` as a safety net against anchor snapshots that
 * momentarily disagree with the target pane's actual scrollable range.
 */
export function computeSlidingReferenceTarget({
  sourceProgress,
  referenceY,
  targetViewportHeight,
  targetMaxScroll,
}: SlidingReferenceTargetInput): number | null {
  if (isProgressNearStart(sourceProgress)) return 0;
  if (isProgressNearEnd(sourceProgress)) return targetMaxScroll;
  if (referenceY === null) return null;
  const raw = referenceY - sourceProgress * targetViewportHeight;
  return Math.max(0, Math.min(targetMaxScroll, raw));
}

/**
 * Density-compensated editor→preview target. The source viewport's mapped
 * top and bottom reveal whether the target renders that same source span
 * taller than its own viewport. When it does, reduce the reference's target
 * viewport fraction just enough to keep the mapped bottom edge visible;
 * otherwise this is the existing sliding-reference placement.
 */
export function computeDensityCompensatedReferenceTarget({
  sourceProgress,
  topReferenceY,
  bottomReferenceY,
  targetViewportHeight,
  targetMaxScroll,
}: DensityCompensatedReferenceTargetInput): number | null {
  if (isProgressNearStart(sourceProgress)) return 0;
  if (isProgressNearEnd(sourceProgress)) return targetMaxScroll;
  if (topReferenceY === null || bottomReferenceY === null) return null;

  const sourceSpanInTarget = bottomReferenceY - topReferenceY;
  const referenceY = (1 - sourceProgress) * topReferenceY + sourceProgress * bottomReferenceY;
  const compensatedViewportFraction = Math.max(0, Math.min(sourceProgress, 1 - (sourceSpanInTarget / targetViewportHeight) * (1 - sourceProgress)));
  const raw = referenceY - compensatedViewportFraction * targetViewportHeight;
  return Math.max(0, Math.min(targetMaxScroll, raw));
}
