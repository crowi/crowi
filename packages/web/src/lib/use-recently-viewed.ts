'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';

export const recentlyViewedKeys = {
  all: ['me', 'recently-viewed'] as const,
};

/**
 * Lazy: only fetches once `enabled` flips true (dropdown opens). Short
 * staleTime because the list shifts on every page view and the
 * dropdown re-opens often.
 *
 * RFC-0006 Phase 4 Batch 2 — migrated to `apiClient.me['recently-viewed-pages'].$get`.
 */
export function useRecentlyViewedPages(opts: { enabled: boolean }) {
  return useQuery({
    queryKey: recentlyViewedKeys.all,
    queryFn: async () => {
      const response = await apiClient.me['recently-viewed-pages'].$get();
      if (!response.ok) {
        throw new Error('Failed to load recently viewed pages');
      }
      return await response.json();
    },
    enabled: opts.enabled,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
