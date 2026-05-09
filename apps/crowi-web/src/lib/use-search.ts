'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
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
  query: (params: UseSearchPagesParams) =>
    [...searchKeys.all, 'pages', params.q, params.type ?? null, params.tree ?? null, params.page ?? 1, params.limit ?? 50] as const,
};

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
    gcTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
