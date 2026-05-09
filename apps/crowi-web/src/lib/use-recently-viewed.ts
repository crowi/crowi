'use client';

import { useQuery } from '@tanstack/react-query';
import type { RecentlyViewedPagesResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

/**
 * Query-key factory. Wrapped so `gcTime` purges and targeted
 * invalidations (e.g. after a page rename) have a consistent handle.
 */
export const recentlyViewedKeys = {
  all: ['me', 'recently-viewed'] as const,
};

/**
 * Per-user recently-viewed pages, backed server-side by `crowi.lru`
 * (Redis sorted set). Used by the global search dropdown's empty
 * state. Lazy: nothing is fetched until `enabled` flips true (= the
 * dropdown opens).
 *
 * `staleTime` is short on purpose: the list moves whenever the user
 * opens a different page, and we re-show the dropdown often. 30s
 * keeps repeated focus events cheap without showing wildly stale data.
 */
export function useRecentlyViewedPages(opts: { enabled: boolean }) {
  return useQuery<RecentlyViewedPagesResponse, Error>({
    queryKey: recentlyViewedKeys.all,
    queryFn: async () => {
      const result = await apiClient.me.recentlyViewedPages();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: 'Failed to load recently viewed pages' },
        fallback: 'Failed to load recently viewed pages',
      });
    },
    enabled: opts.enabled,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
