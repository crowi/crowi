'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drives the expanded ⇄ compact state of the page-view sticky header.
 *
 * The `(auth)` layout has no inner scroll container — the document body
 * scrolls and the shared app header simply flows away. {@link PageHeader}
 * is `sticky top-0`, so it stays pinned once the page scrolls past it.
 *
 * To know *when* the header has scrolled into its pinned position we
 * place a zero-height sentinel `<div>` immediately before the header and
 * observe it with an `IntersectionObserver` rooted at the viewport
 * (`root: null`). While the sentinel is visible the page is at (or near)
 * the top → expanded; once it leaves the viewport the header is pinned →
 * compact.
 *
 * SSR-safe: the observer is only created inside `useEffect`, so the hook
 * renders `compact: false` on the server and during the first client
 * paint, then upgrades once the sentinel is measured.
 */
export interface StickyHeaderState {
  /** Attach to a zero-height `<div>` rendered just before the header. */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** `true` once the sentinel has scrolled out of the viewport. */
  compact: boolean;
}

export function useStickyHeader(): StickyHeaderState {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Sentinel visible → at the top → expanded; gone → pinned → compact.
        setCompact(!entry.isIntersecting);
      },
      { root: null, threshold: 0 },
    );
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, []);

  return { sentinelRef, compact };
}
