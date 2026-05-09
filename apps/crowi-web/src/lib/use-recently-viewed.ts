'use client';

import { useQuery } from '@tanstack/react-query';
import type { RecentlyViewedPagesResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

export const recentlyViewedKeys = {
  all: ['me', 'recently-viewed'] as const,
};

/**
 * Lazy: only fetches once `enabled` flips true (dropdown opens). Short
 * staleTime because the list shifts on every page view and the
 * dropdown re-opens often.
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
