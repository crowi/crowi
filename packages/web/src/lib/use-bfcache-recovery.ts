'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Recover app state after a back/forward-cache (bfcache) restore.
 *
 * When the user clicks a link that does a *full-page* navigation away from
 * the Next.js app (e.g. an attachment link to `/api/v2/attachments/<id>`,
 * which the API serves as a raw file) and then presses Back, the browser
 * restores the previous page from bfcache. The page is frozen, not
 * re-mounted: React state survives, but any `fetch()` that was in flight at
 * freeze time is left hanging — the promise is neither resolved nor
 * rejected on restore.
 *
 * Concretely this leaves:
 *  - `useAuth`'s `/auth/me` request stuck → `isLoading` never clears →
 *    the `(auth)` layout shows a permanent bare "Loading..." screen.
 *  - any react-query query that was `fetching` stuck in `pending` →
 *    `PageView` shows its `LoadingSpinner` forever.
 *
 * The `pageshow` event with `event.persisted === true` is the only signal
 * a bfcache restore happened. On restore we:
 *  1. re-run the auth check so a hung `/auth/me` is replaced by a fresh one,
 *  2. invalidate active queries so any hung query refetches.
 *
 * Mounted once at the `(auth)` layout level so it covers the whole
 * authenticated subtree.
 */
export function useBfcacheRecovery(recheckAuth: () => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // Re-issue the auth check; a fetch hung at freeze time never settles.
      recheckAuth();
      // Refetch active queries so a hung page query (etc.) recovers.
      queryClient.invalidateQueries({ type: 'active' });
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [recheckAuth, queryClient]);
}
