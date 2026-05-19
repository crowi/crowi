'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Recover app state after a back/forward-cache (bfcache) restore.
 *
 * When the user clicks a link that does a *full-page* navigation away
 * from the Next.js app (e.g. an attachment link to
 * `/api/v2/attachments/<id>`, which the API serves as a raw file — the
 * browser then shows a PDF in its built-in viewer) and presses Back,
 * the browser restores the previous page from the bfcache. The page is
 * frozen, not re-mounted: React state survives, but any `fetch()` that
 * was in flight at freeze time is left hanging — the promise is neither
 * resolved nor rejected on restore.
 *
 * The page-view screen holds open WebSocket connections (RFC-0005
 * presence via `use-presence.ts`, RFC-0003 collab). Whether Chrome keeps
 * such a page in the bfcache is version- and condition-dependent:
 *  - **bfcache restore** — `pageshow` fires with `persisted === true`;
 *    the frozen `fetch()` strands as above.
 *  - **non-bfcache restore** — the page was evicted (or never cached)
 *    and Back is a full reload; `pageshow` fires with `persisted ===
 *    false`. A *clean* full reload re-mounts React and resolves on its
 *    own — but Chrome can also reuse the page object while still
 *    stranding an in-flight `fetch()` and report `persisted === false`,
 *    which leaves the exact same hung-promise state with none of the
 *    bfcache signal.
 *
 * So gating recovery on `persisted` alone misses the second path. We
 * instead gate on "this document has already been shown once" — the
 * first `pageshow` of a fresh document is the initial load (nothing to
 * recover), every later `pageshow` is a restore of one kind or the other.
 *
 * A frozen-fetch restore leaves:
 *  - `useAuth`'s `/auth/me` request stuck → `isLoading` never clears →
 *    the `(auth)` layout shows a permanent bare "Loading..." screen.
 *  - any react-query query that was `fetching` stuck in `fetchStatus:
 *    'fetching'` → `PageView` shows its `LoadingSpinner` forever.
 *
 * On a restore `pageshow` we recover both:
 *  1. re-run the auth check so a hung `/auth/me` is replaced by a fresh
 *     one.
 *  2. un-stick every active query. **`invalidateQueries` alone does NOT
 *     work here**: React Query dedupes against the in-flight request and
 *     will not start a second fetch while the (never-settling) frozen
 *     one is still outstanding — the query stays `pending` forever. We
 *     must `cancelQueries` first, which rejects the stuck observers and
 *     drops the in-flight reference, and only then `refetchQueries` to
 *     issue genuinely fresh requests.
 *
 * Recovery is idempotent: on a clean full reload there is nothing
 * in-flight to cancel and `refetchQueries` merely re-validates, so
 * running it on a `persisted === false` restore is a harmless no-op
 * when the reload already healed itself, and the actual fix when it
 * did not.
 *
 * Mounted once at the `(auth)` layout level so it covers the whole
 * authenticated subtree.
 */
export function useBfcacheRecovery(recheckAuth: () => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // The first `pageshow` of a freshly-loaded document is the initial
    // load, not a restore — skip it. Every `pageshow` after that is a
    // Back/Forward restore (bfcache `persisted: true` or a reload-style
    // `persisted: false`), and either can strand an in-flight fetch.
    let initialLoadHandled = false;

    const handlePageShow = async () => {
      if (!initialLoadHandled) {
        initialLoadHandled = true;
        return;
      }
      // Re-issue the auth check; a fetch hung at freeze time never settles.
      recheckAuth();
      // Un-stick any query frozen mid-fetch. `invalidateQueries` would
      // dedupe against the never-settling in-flight request, so cancel
      // first (rejecting stuck observers + dropping the in-flight ref),
      // then force a fresh fetch so a hung page query (etc.) recovers.
      await queryClient.cancelQueries({ type: 'active' });
      await queryClient.refetchQueries({ type: 'active' });
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [recheckAuth, queryClient]);
}
