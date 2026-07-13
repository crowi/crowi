'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * id of the `<main>` landmark that route-level focus management targets.
 * Shared here (rather than duplicated as a string literal in each shell
 * layout and the skip-link `href`) so the three call sites can never drift.
 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Moves focus to `#main-content` whenever a client-side route transition
 * completes.
 *
 * The authenticated app shell ((auth)/(admin) layouts) is a client-rendered
 * SPA: a Next `<Link>` navigation swaps `children` in place without a full
 * page load, so neither focus nor an accessibility announcement moves on
 * its own — a keyboard/screen-reader user stays wherever they were (often
 * back up in the header) after every route change. This hook restores that
 * signal by focusing the `<main id="main-content" tabIndex={-1}>` landmark
 * each time `usePathname()` reports a new pathname.
 *
 * **First mount is deliberately skipped.** Stealing focus on the very
 * first paint would fight the browser's own initial-load focus behaviour
 * (e.g. a user tabbing from the address bar), so a `useRef` latch lets the
 * first render through untouched and only acts on the 2nd+ pathname value.
 *
 * A "logic-only" hook (no JSX) — mirrors `useNotificationsSocket` /
 * `useStickyHeader`: mounted once per shell layout, adds no node to the
 * component tree.
 */
export function useRouteFocus(): void {
  const pathname = usePathname();
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  }, [pathname]);
}
