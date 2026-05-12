'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { GetPageRequest, PageWithRevision } from '@crowi/api-contract';

export interface PageState {
  page: PageWithRevision | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  notFound: boolean;
  notGranted: boolean;
  redirectTo: string | null;
  isDeleted: boolean;
}

export function usePage(params: GetPageRequest) {
  const query = useQuery({
    queryKey: ['page', params],
    queryFn: async () => {
      const result = await apiClient.page.getPage({ query: params });

      if (result.status === 200) {
        return {
          page: result.body.page,
          notFound: false,
          notGranted: false,
        };
      }

      if (result.status === 404) {
        return {
          page: null,
          notFound: true,
          notGranted: false,
        };
      }

      if (result.status === 403) {
        return {
          page: null,
          notFound: false,
          notGranted: true,
        };
      }

      // Handle 401 (authentication required) - throw to trigger error state
      throw new Error('Failed to fetch page');
    },
    // Don't retry on 404 or 403
    retry: (failureCount, error) => {
      if (error.message === 'Failed to fetch page') {
        return failureCount < 3;
      }
      return false;
    },
    // Enable query only when we have either path or page_id
    enabled: Boolean(params.path || params.page_id),
  });

  // Derive page state
  const pageState: PageState = {
    page: query.data?.page ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    notFound: query.data?.notFound ?? false,
    notGranted: query.data?.notGranted ?? false,
    redirectTo: query.data?.page?.redirectTo ?? null,
    isDeleted: query.data?.page?.status === 'deleted',
  };

  return {
    ...pageState,
    refetch: query.refetch,
  };
}
