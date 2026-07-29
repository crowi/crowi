'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Live CSS media-query test, as a `useSyncExternalStore` subscription over
 * `window.matchMedia`.
 *
 * `useSyncExternalStore` (rather than `useState` + an effect) is what keeps
 * this SSR-safe and free of the "setState in effect" cascading-render lint
 * warning. The SSR / first-hydration snapshot is always `false`; React
 * re-renders with the real value immediately after hydration, so a matching
 * viewport shows the non-matching branch for at most one commit.
 *
 * Prefer Tailwind's responsive utilities for anything that is merely a
 * different presentation of the same DOM — they need no JS and no hydration
 * round-trip. Reach for this only when the two states must render DIFFERENT
 * DOM, or when a `display: none` subtree would still be wrong because its
 * children would mount, run effects and hold state.
 */
function getServerSnapshot(): boolean {
  return false;
}

export function useMediaQuery(query: string): boolean {
  // `getSnapshot` runs on every render of the consuming component (not
  // just on actual media-query changes — that's the `useSyncExternalStore`
  // contract), so a fresh `window.matchMedia(query)` call there would
  // construct a new `MediaQueryList` far more often than the query
  // actually changes. Cache one per distinct `query` in a ref instead;
  // `subscribe` (called from an effect) reads the same cached instance.
  const mqlRef = useRef<{ query: string; mql: MediaQueryList } | null>(null);
  const getMql = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (mqlRef.current === null || mqlRef.current.query !== query) {
      mqlRef.current = { query, mql: window.matchMedia(query) };
    }
    return mqlRef.current.mql;
  }, [query]);

  const subscribe = useCallback(
    (callback: () => void) => {
      const mql = getMql();
      if (!mql) return () => {};
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [getMql],
  );
  const getSnapshot = useCallback(() => getMql()?.matches ?? false, [getMql]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
