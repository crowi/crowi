'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { GetBacklinksResponse } from '@crowi/api-contract';

export const backlinksKeys = {
  all: ['backlinks'] as const,
  // `limit` and `offset` are part of the cache key so widening the limit
  // (e.g. clicking "Read More") doesn't collide with the smaller-limit cache.
  detail: (pageId: string, limit: number, offset: number) => ['backlinks', pageId, { limit, offset }] as const,
  pagePrefix: (pageId: string) => ['backlinks', pageId] as const,
};

const EMPTY_RESULT: GetBacklinksResponse = { backlinks: [], hasNext: false };

// Backlinks change only when other pages link to/unlink from this page (i.e. on
// page save). Hold the result long enough to survive page-view rerenders /
// window focus without re-hitting the API.
const BACKLINKS_STALE_TIME = 30 * 1000;

interface UseBacklinksOptions {
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

/**
 * Fetch the list of backlinks targeting a page. Errors fall back to empty —
 * this is auxiliary UI and shouldn't break the page view.
 *
 * `limit` defaults to 5 (matches the legacy React UI's first page); `offset`
 * defaults to 0. The hook returns `hasNext` so callers can render a
 * "Read More" affordance without an over-fetch trick.
 */
export function useBacklinks(pageId: string | undefined, options: UseBacklinksOptions = {}) {
  const limit = options.limit ?? 5;
  const offset = options.offset ?? 0;
  return useQuery({
    queryKey: pageId ? backlinksKeys.detail(pageId, limit, offset) : backlinksKeys.all,
    queryFn: async (): Promise<GetBacklinksResponse> => {
      if (!pageId) return EMPTY_RESULT;
      const result = await apiClient.backlink.getBacklinks({
        query: { page_id: pageId, limit, offset },
      });
      return result.status === 200 ? result.body : EMPTY_RESULT;
    },
    enabled: !!pageId && options.enabled !== false,
    staleTime: BACKLINKS_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}
