'use client';

import { useCallback, useSyncExternalStore } from 'react';

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
  const subscribe = useCallback(
    (callback: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
