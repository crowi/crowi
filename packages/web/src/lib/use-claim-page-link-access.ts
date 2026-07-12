'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { PageWithRevision } from '@crowi/api-contract';
import { isLinkOnlyGrant } from './page-grant';
import { pageChildrenKeys } from './use-page-children';
import { searchKeys } from './use-search';
import type { PageState } from './use-page';

/**
 * feature-restricted-grant-share-banner Phase 1 — grant-on-first-access.
 *
 * `IdRedirector` is the ONLY caller of `POST /pages/link-access`
 * (`claimPageLinkAccessRoute`). Every id-URL landing must re-attempt the
 * claim on mount so a `GRANT_RESTRICTED` page's first visitor is actually
 * added to `grantedUsers` — a normal read-through cache (like `usePage`'s
 * 30s `staleTime`) would let an earlier "not granted" or "already granted"
 * resolution silently reuse the cached result and skip the write on a
 * later visit. The cache is therefore intentionally defeated: `staleTime`
 * / `gcTime` 0 plus `refetchOnMount: 'always'` guarantee a fresh POST on
 * every mount, and `retry` / window-focus / reconnect refetches are all
 * disabled so a rejected claim never silently retries behind the scenes.
 *
 * 429 (rate-limited) is not given a dedicated branch — it surfaces as
 * `isError`, which `IdRedirector`'s existing `ErrorAlert` branch already
 * renders.
 */

function invalidateAfterClaim(queryClient: QueryClient, page: PageWithRevision): void {
  // Only a GRANT_RESTRICTED resolution can have just added the caller to
  // `grantedUsers` (or be a repeat claim invalidating an earlier stale
  // 403) — public / owner / specified pass-through claims make zero ACL
  // changes, so invalidating here would only cause unrelated cache churn.
  if (!isLinkOnlyGrant(page.grant)) {
    return;
  }

  queryClient.invalidateQueries({ queryKey: ['page', { path: page.path }] });
  queryClient.invalidateQueries({ queryKey: ['pages', 'list'] });
  queryClient.invalidateQueries({ queryKey: searchKeys.all });
  queryClient.invalidateQueries({ queryKey: pageChildrenKeys.all });
}

export function useClaimPageLinkAccess(pageId: string): PageState {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['page-link-access', pageId],
    queryFn: async () => {
      const response = await apiClientV2.pages['link-access'].$post({
        json: { page_id: pageId },
      });

      if (response.status === 200) {
        const body = await response.json();
        const page = body.page as PageWithRevision;
        invalidateAfterClaim(queryClient, page);
        return {
          page,
          notFound: false,
          notGranted: false,
        };
      }

      if (response.status === 404) {
        return {
          page: null,
          notFound: true,
          notGranted: false,
        };
      }

      if (response.status === 403) {
        return {
          page: null,
          notFound: false,
          notGranted: true,
        };
      }

      // 400 (invalid id) / 401 (auth required) / 429 (rate limited) — no
      // dedicated branch, surfaced as a generic error.
      throw new Error('Failed to claim page link access');
    },
    enabled: Boolean(pageId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    page: query.data?.page ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    notFound: query.data?.notFound ?? false,
    notGranted: query.data?.notGranted ?? false,
    redirectTo: query.data?.page?.redirectTo ?? null,
    isDeleted: query.data?.page?.status === 'deleted',
  };
}
