'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
 * @param frozen - feature-mobile-presence-card — `true` while the mobile
 *   presence card's self-only collapse animation is in flight. The
 *   animating card slot is itself part of the expanded header's flow
 *   height, so without this the mid-transition reflow it causes could
 *   flip `compact` mid-animation. While `true` the threshold is pinned
 *   to the `H` that was current when it became `true`; on the `true` →
 *   `false` edge (transition end/cancel) it re-evaluates exactly once
 *   against the THEN-current `H` and `scrollY`. Reflow tracking outside
 *   a transition (font load, breadcrumb wrap, …) is unaffected — this
 *   only pins the threshold, it never stops `H` itself from updating.
 */
export interface StickyHeaderState {
  /** `true` once the document has scrolled at least `expandedHeight` px. */
  compact: boolean;
}

export function useStickyHeader(expandedHeight: number, frozen = false): StickyHeaderState {
  const [compact, setCompact] = useState(false);

  // Mirrors `expandedHeight` into a ref inside a LAYOUT effect (fires
  // synchronously right after this commit, before the browser paints or
  // dispatches any new event — never during render itself, which the
  // `react-hooks/refs` rule forbids). By the time any LATER effect for
  // this commit runs (including a scroll/resize listener registered on
  // an EARLIER render that hasn't been replaced yet), the ref already
  // holds the value from the render that just committed. This is what
  // closes the resize race below: a native `resize` event can fire the
  // ResizeObserver-driven `expandedHeight` update and this hook's own
  // `resize` listener in an order the browser does not guarantee — both
  // are "after layout, before paint" callbacks with no defined
  // precedence between a ResizeObserver callback and a `window.resize`
  // listener. Reading `heightRef.current` (rather than a value captured
  // in the listener's closure at registration time) means the listener
  // always sees the LATEST measured `H` by the time it next fires
  // (guaranteed to be after this synchronous layout effect, since the
  // browser cannot dispatch a new event mid-commit), instead of racing
  // against a stale closure.
  const heightRef = useRef(expandedHeight);
  useLayoutEffect(() => {
    heightRef.current = expandedHeight;
  }, [expandedHeight]);

  // Set while `frozen` — holds the `H` that was current the instant
  // freezing started, so `evaluate` below can pin against it instead of
  // the (possibly still-reflowing-mid-transition) live `heightRef`.
  const frozenHeightRef = useRef<number | null>(null);

  // A stable function identity (never recreated) that always reads the
  // LATEST refs at call time — that is what makes the layout-effect
  // mirroring above pay off. Kept in a ref itself so both effects below
  // can share the exact same listener/re-evaluation entry point without
  // needing to re-subscribe `window` listeners on every `H` change.
  const evaluateRef = useRef(() => {
    if (typeof window === 'undefined') return;
    const h = frozenHeightRef.current ?? heightRef.current;
    // An unmeasured header (`H <= 0`) must never compact: there is no
    // valid threshold yet, and the placeholder height would be wrong.
    setCompact(h > 0 && window.scrollY >= h);
  });

  // Scroll/resize listeners are attached ONCE (mount-only) — they always
  // read the current `H` (or frozen `H`) via the refs above at call
  // time, so there is no need to tear down and re-add them on every `H`
  // change the way the previous implementation did.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const evaluate = evaluateRef.current;
    evaluate();
    window.addEventListener('scroll', evaluate, { passive: true });
    window.addEventListener('resize', evaluate);
    return () => {
      window.removeEventListener('scroll', evaluate);
      window.removeEventListener('resize', evaluate);
    };
  }, []);

  // Reflow tracking: every genuine `H` change re-evaluates immediately —
  // exactly like the previous per-`H` effect re-run did — UNLESS a card
  // transition currently has the threshold frozen, in which case the new
  // `H` is recorded (via `heightRef` above) but does not affect `compact`
  // until the freeze lifts.
  useEffect(() => {
    if (frozenHeightRef.current === null) {
      evaluateRef.current();
    }
    // `expandedHeight` (mirrored into `heightRef` above) is the real
    // dependency here; `evaluateRef` never changes identity.
  }, [expandedHeight]);

  // Freeze / unfreeze on `frozen` edges.
  useEffect(() => {
    if (frozen) {
      frozenHeightRef.current = heightRef.current;
      return;
    }
    if (frozenHeightRef.current !== null) {
      frozenHeightRef.current = null;
      evaluateRef.current();
    }
  }, [frozen]);

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
