'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { SearchPagesResponse, SearchPageType } from '@crowi/api-contract';

/**
 * Surfaces a 503 from the search endpoint so the UI can render an
 * operator-friendly "search is disabled" panel instead of a generic error.
 * The handler returns 503 when no `@crowi/plugin-search-*` driver is
 * registered in the runner project.
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

/**
 * Query-key factory for the search hook. The key is shaped so that React
 * Query treats different `(q, type, tree, page, limit)` combinations as
 * independent caches — important because tab switches and pagination should
 * not bleed stale results across each other.
 */
export const searchKeys = {
  all: ['search'] as const,
  query: (params: UseSearchPagesParams) =>
    [...searchKeys.all, 'pages', params.q, params.type ?? null, params.tree ?? null, params.page ?? 1, params.limit ?? 50] as const,
};

/**
 * Fetch search results from `GET /api/v2/search`.
 *
 * - When `q` is empty, the query is disabled and returns `undefined` data —
 *   the page-level component renders an "enter a query" empty state in that
 *   case. This mirrors the legacy `controllers/search.ts:!keyword` early
 *   return without forcing a 400 round-trip.
 * - 503 maps to `SearchDisabledError` so the page can render a dedicated
 *   "install a search plugin" hint with an admin link.
 * - 401 is left to the surrounding `(auth)` layout to catch (the global
 *   refresh-then-redirect dance lives there).
 */
export function useSearchPages(params: UseSearchPagesParams) {
  const enabled = params.q.length > 0;
  return useQuery({
    queryKey: searchKeys.query(params),
    queryFn: async (): Promise<SearchPagesResponse> => {
      const result = await apiClient.search.searchPages({
        query: {
          q: params.q,
          page: params.page,
          limit: params.limit,
          type: params.type,
          tree: params.tree,
        },
      });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: {
          503: { message: 'Search is not configured.', ErrorClass: SearchDisabledError },
        },
        fallback: 'Failed to search pages',
      });
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    // Search results are short-lived: keep them around for ~1min after the
    // last subscriber unmounts, then drop. (Default is 5min.)
    gcTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
