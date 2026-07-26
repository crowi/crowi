/**
 * feature-mobile-presence-card — scroll-position compensation for the
 * self-only presence card's enter/exit.
 *
 * `MobilePresenceCard`'s self-only collapse inserts/removes a slot above
 * the article body. Native CSS scroll anchoring (`overflow-anchor`) cannot
 * be relied on: WebKit (i.e. current stable iOS Safari, the spec's named
 * target) does not implement it at all, while Blink/Gecko do. So the
 * reading position is corrected in JS — but in a way that stays correct on
 * the engines that DO anchor, instead of fighting them.
 *
 * Kept pure/DOM-measurement-minimal, the same "extract the math" pattern
 * `scroll-sync-math.ts` uses for `use-scroll-sync.ts` — `measureSlot` is
 * the only function that touches the DOM; every decision is a plain
 * function over the numbers it returns.
 *
 * ## Why the slot's TRAILING EDGE, not its height
 *
 * The naive version measures the slot's height before/after and scrolls by
 * `ΔH`. That is right only on an engine with no scroll anchoring: where
 * the engine already adjusted the scroll offset itself, adding `ΔH` on top
 * DOUBLE-compensates and yanks the body the other way.
 *
 * The slot's own bottom edge, in viewport coordinates, is the flow
 * position of everything that follows it — the body the reader is reading.
 * Measuring THAT before and after makes the correction self-cancelling:
 *
 *   - no native anchoring (WebKit): the slot grows downward, its bottom
 *     edge moves down by `ΔH`, and we scroll by exactly that;
 *   - native anchoring (Blink/Gecko): the engine has already shifted the
 *     scroll offset, so the bottom edge did not move — the delta is 0 and
 *     we do nothing;
 *   - partial/suppressed anchoring: the delta is whatever the engine left
 *     uncorrected, which is exactly what needs correcting.
 *
 * The reader's actual anchor element is somewhere below the slot and moves
 * in lockstep with it, so the slot's trailing edge stands in for it
 * without having to pick or track a specific body element.
 */

export interface SlotMeasurement {
  /**
   * The slot's viewport-relative top edge. Negative once the reader has
   * scrolled past the slot. Used only to decide WHETHER to compensate.
   */
  top: number;
  /**
   * The slot's viewport-relative bottom edge — the flow position of the
   * body content that follows the slot, and therefore the quantity the
   * compensation keeps constant.
   */
  bottom: number;
}

/** Measures the slot element's current geometry. The only DOM-touching
 * function in this module — call once right before a visibility change
 * and again once it has settled. */
export function measureSlot(el: Element): SlotMeasurement {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/**
 * How far the content below the slot drifted, in viewport pixels, and
 * therefore how far to scroll to put it back. Positive: the slot pushed
 * the body down — scroll DOWN by this much. Negative: the slot pulled the
 * body up — scroll UP.
 */
export function computeScrollCompensation(before: SlotMeasurement, after: SlotMeasurement): number {
  return after.bottom - before.bottom;
}

/**
 * Whether a compensating scroll should actually be applied.
 *
 * The thing being protected is the reader's position in the BODY, which
 * always sits below this slot — so the compensation applies whenever the
 * slot's height change actually displaces on-screen body content, which
 * is whenever any part of the viewport lies below the slot's top edge.
 * That deliberately includes the case where the card itself is (partly or
 * fully) visible: a reader can be looking at the paragraph under a card
 * they can also see, and letting that paragraph slide by the slot's height
 * is exactly the jump this exists to prevent. Compensating then costs a
 * shift of whatever is ABOVE the slot (breadcrumb / title / chips), which
 * nobody is reading while the body is on screen. (Under native scroll
 * anchoring the engine has already made this same trade-off — the delta
 * is 0 and nothing extra happens.)
 *
 * Two cases are excluded:
 *
 *   - a sub-pixel delta (rounding noise);
 *   - a slot that starts at or below the fold (`top >= viewportHeight`):
 *     everything it displaces is off-screen below too, so nothing the
 *     reader can see moves, and scrolling would BE the jump rather than
 *     prevent one. (Unreachable in practice — the slot lives in the page
 *     header, so its top is only ever at or above the viewport — but the
 *     predicate is defined for the general case rather than assuming it.)
 *
 * The spec's other carve-outs — user-initiated scroll, the compact-header
 * toggle, unmount, reduced motion — never reach this function at all: the
 * caller only invokes the compensation path for the self-only card's own
 * enter/exit transition.
 *
 * Keeping the body pinned also keeps the sticky header's `scrollY >= H`
 * compact threshold stable across the transition: `H` changes by exactly
 * the same delta as `scrollY`, so a collapse can never flip the header
 * between expanded and compact on its own.
 */
export function shouldCompensate(slotViewportTop: number, delta: number, viewportHeight: number): boolean {
  if (Math.abs(delta) < 1) return false;
  if (slotViewportTop >= viewportHeight) return false;
  return true;
}

/** Applies the compensation. `scrollBy` is injectable for testing; defaults
 * to `window.scrollBy`. */
export function applyScrollCompensation(delta: number, scrollBy: (x: number, y: number) => void = (x, y) => window.scrollBy(x, y)): void {
  scrollBy(0, delta);
}
