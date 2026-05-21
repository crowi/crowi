'use client';

// TS2589-RFC-0006-PHASE-6: `response.json() as RecentlyViewedPagesResponse`
// cast below exists because `apiClientV2` is typed as `any` (TS2589 limit
// in `client.ts`). Drop the cast in Phase 6 once `hc<AppType>` recovers
// strict typing.

import { useQuery } from '@tanstack/react-query';
import type { RecentlyViewedPagesResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';

export const recentlyViewedKeys = {
  all: ['me', 'recently-viewed'] as const,
};

/**
 * Lazy: only fetches once `enabled` flips true (dropdown opens). Short
 * staleTime because the list shifts on every page view and the
 * dropdown re-opens often.
 *
 * RFC-0006 Phase 4 Batch 2 — migrated to `apiClientV2.me['recently-viewed-pages'].$get`.
 */
export function useRecentlyViewedPages(opts: { enabled: boolean }) {
  return useQuery({
    queryKey: recentlyViewedKeys.all,
    queryFn: async () => {
      const response = await apiClientV2.me['recently-viewed-pages'].$get();
      if (!response.ok) {
        throw new Error('Failed to load recently viewed pages');
      }
      return (await response.json()) as RecentlyViewedPagesResponse;
    },
    enabled: opts.enabled,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
