'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { decodePagePathFromUrl } from './page-path';

/**
 * id of the `<main>` landmark that route-level focus management targets.
 * Shared here (rather than duplicated as a string literal in each shell
 * layout and the skip-link `href`) so the three call sites can never drift.
 */
export const MAIN_CONTENT_ID = 'main-content';

// Module-level rather than context: the redirecting page sits below the
// layout that owns the hook. Held as the page path the redirect is headed
// for, not a bare flag, so a redirect that never lands (the reader followed a
// link first) cannot swallow the focus move of the navigation that does.
let skipTarget: string | null = null;

/**
 * Leave focus alone when the pathname next changes to `pagePath`. For a
 * `router.replace` that is part of arriving at a URL rather than a navigation
 * the reader made. It lands before any input, where the browser draws a
 * programmatic focus as `:focus-visible`, so the page would open with a ring
 * around it; an ordinary page load gets no focus move at all. The next
 * pathname change uses the request up, whatever it is.
 *
 * Every redirect that corrects the URL the reader opened belongs here:
 * `/<id>` → the page's path (`IdRedirector`), a path a rename moved away
 * from, and a link that arrived percent-encoded twice (both in `PageView`).
 */
export function skipRouteFocusFor(pagePath: string): void {
  skipTarget = pagePath;
}

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
 * (e.g. a user tabbing from the address bar), so focus only moves when the
 * pathname actually *changes* from its previous value. This is intentionally
 * a previous-pathname comparison, not a "skip the first effect" boolean latch:
 * React StrictMode (dev default) double-invokes the mount effect, and a
 * boolean latch consumed by the first invoke would let the second invoke
 * steal focus on initial load — surfacing a spurious focus-visible ring on
 * `#main-content` right after a page load. The comparison is idempotent under
 * such a double-invoke (the second run sees the ref already equal to
 * `pathname`).
 *
 * A "logic-only" hook (no JSX) — mirrors `useNotificationsSocket` /
 * `useStickyHeader`: mounted once per shell layout, adds no node to the
 * component tree.
 */
export function useRouteFocus(): void {
  const pathname = usePathname();
  // Seeded with the initial pathname so the first render focuses nothing; only
  // an actual pathname change moves focus. See the doc comment above for why
  // this is a previous-value comparison rather than a first-render boolean
  // latch (StrictMode double-invoke safety).
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) {
      return;
    }
    // Updated before the skip check, so a skipped pathname becomes the one
    // later changes are measured from.
    previousPathnameRef.current = pathname;
    // `usePathname()` is still URL-encoded (`+`, `%XX`); the request holds the
    // real page path.
    const isSkipped = skipTarget !== null && decodePagePathFromUrl(pathname) === skipTarget;
    skipTarget = null;
    if (isSkipped) return;
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  }, [pathname]);
}
