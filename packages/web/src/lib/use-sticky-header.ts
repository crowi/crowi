'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drives the expanded ⇄ compact state of the page-view sticky header.
 *
 * The `(auth)` layout has no inner scroll container — the document body
 * scrolls. There is a single {@link PageHeader} element: while expanded
 * it sits in normal document flow; once compacted it becomes a
 * `position: fixed` overlay and a placeholder `<div>` of the *expanded*
 * header's height `H` takes its place in flow.
 *
 * ## Why this kills the flicker
 *
 * The compact header is shorter than the expanded one. If the header
 * stayed in flow, compacting it would shrink the document, pull content
 * up, and flip the trigger back — an infinite expanded⇄compact loop at
 * the boundary.
 *
 * The fix decouples the trigger from the header's own height:
 *
 * 1. The placeholder is *always* exactly `H` tall while compact, so the
 *    main content's flow position never moves when the header toggles.
 * 2. The trigger is a plain `scrollY >= H` check. Because flow is
 *    constant across the toggle, `scrollY` is stable across it too — the
 *    boundary can no longer oscillate.
 *
 * `H` is measured by the caller (a `ResizeObserver` on the expanded
 * header) and fed back in via {@link useStickyHeader}'s argument so the
 * threshold tracks the real expanded height even if it reflows.
 *
 * SSR-safe: the scroll listener is only attached inside `useEffect`, so
 * the hook renders `compact: false` on the server and during the first
 * client paint, then upgrades once mounted.
 *
 * @param expandedHeight - The measured height `H` of the expanded
 *   header, in CSS pixels. `0` (not yet measured) keeps the header
 *   expanded — we never compact against an unknown threshold.
 */
export interface StickyHeaderState {
  /** `true` once the document has scrolled at least `expandedHeight` px. */
  compact: boolean;
}

export function useStickyHeader(expandedHeight: number): StickyHeaderState {
  const [compact, setCompact] = useState(false);

  // The effect re-runs whenever `H` changes (a rare reflow event), so
  // the listener always closes over the current threshold — no ref
  // gymnastics, and it also re-evaluates `compact` immediately on the
  // new `H`. Scroll events themselves never change `H`.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const evaluate = () => {
      // An unmeasured header (`H <= 0`) must never compact: there is no
      // valid threshold yet, and the placeholder height would be wrong.
      setCompact(expandedHeight > 0 && window.scrollY >= expandedHeight);
    };

    evaluate();
    window.addEventListener('scroll', evaluate, { passive: true });
    window.addEventListener('resize', evaluate);

    return () => {
      window.removeEventListener('scroll', evaluate);
      window.removeEventListener('resize', evaluate);
    };
  }, [expandedHeight]);

  return { compact };
}

// ---------------------------------------------------------------------------
// Expanded-header height (`H`) measurement — kept deliberately isolated so it
// can be hand-tuned later without touching the trigger logic above.
// ---------------------------------------------------------------------------

export interface MeasuredHeight {
  /** Attach to the element whose flow height should be tracked. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** The element's height in CSS pixels (`0` until first measured). */
  height: number;
}

/**
 * Tracks the height `H` of the expanded page header.
 *
 * `H` is "the offset of the main content from the top of the page-view
 * area when the header is expanded" — it drives both the placeholder
 * spacer height and the `scrollY >= H` compact trigger, so the two stay
 * in lockstep.
 *
 * It is measured off a dedicated **measurement wrapper** that always
 * renders the expanded layout at its natural flow width and is never
 * detached or resized by the compact toggle. A `ResizeObserver` keeps
 * `H` correct across genuine reflows (window resize, font load,
 * breadcrumb wrap, presence row appearing, …) — but crucially the
 * toggle itself never changes that wrapper, so `H` is stable across the
 * expanded⇄compact switch.
 *
 * Kept deliberately small and isolated: `H` can be hand-tuned here
 * later without touching the trigger logic above.
 */
export function useMeasuredHeight(): MeasuredHeight {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => setHeight(el.offsetHeight);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}
