'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { SearchPagesResponse, SearchPageType } from '@crowi/api-contract';

/**
 * 503 from /search means no search plugin is registered. Caught at the page
 * level to render a dedicated "search is disabled" panel.
 */
export class SearchDisabledError extends Error {
  constructor(message?: string) {
    super(message ?? 'Search is not configured.');
    this.name = 'SearchDisabledError';
  }
}

export interface UseSearchPagesParams {
  q: string;
  page?: number;
  limit?: number;
  type?: SearchPageType;
  tree?: string;
}

export const searchKeys = {
  all: ['search'] as const,
  // `limit` is intentionally excluded from the cache key. Both the
  // header dropdown (5 hits) and the /_search page (50 hits) share the
  // same `q`/`type`/`tree`/`page` shape; the dropdown asks for the
  // larger page and slices client-side, so typing in the header
  // pre-warms the cache for an Enter→/_search navigation.
  query: (params: UseSearchPagesParams) => [...searchKeys.all, 'pages', params.q, params.type ?? null, params.tree ?? null, params.page ?? 1] as const,
};

/**
 * RFC-0006 Phase 4 Batch 7 — switched from `apiClient.search.*`
 * (ts-rest) to `apiClient.search.$get` (`createClient`). Wire payload
 * unchanged. 503 SERVICE_UNAVAILABLE branches to `SearchDisabledError`
 * so the consumer can render a "search is disabled" panel instead of a
 * generic failure toast.
 */
export function useSearchPages(params: UseSearchPagesParams) {
  const enabled = params.q.length > 0;
  return useQuery({
    queryKey: searchKeys.query(params),
    queryFn: async (): Promise<SearchPagesResponse> => {
      // `apiClient` serialises query values as strings. `page` / `limit`
      // are coerced by the Zod schema on the server side
      // (`z.coerce.number`); `tree` / `type` stay verbatim.
      const response = await apiClient.search.$get({
        query: {
          q: params.q,
          page: params.page !== undefined ? String(params.page) : undefined,
          limit: params.limit !== undefined ? String(params.limit) : undefined,
          type: params.type,
          tree: params.tree,
        },
      });
      if (response.status === 503) {
        throw new SearchDisabledError('Search is not configured.');
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Failed to search pages');
      }
      return (await response.json()) as SearchPagesResponse;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    gcTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
