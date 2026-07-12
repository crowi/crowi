'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import { pageKeys } from './page-query-keys';
import type { GetPageRequest, PageWithRevision } from '@crowi/api-contract';

/**
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.getPage`
 * (ts-rest) to `apiClientV2.pages.$get` (hc<AppType>). Wire payload is
 * unchanged.
 */
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
    queryKey: pageKeys.detail(params),
    queryFn: async () => {
      const response = await apiClientV2.pages.$get({
        query: {
          path: params.path,
          page_id: params.page_id,
          revision_id: params.revision_id,
        },
      });

      if (response.status === 200) {
        const body = await response.json();
        return {
          page: body.page as PageWithRevision,
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

      // 401 (authentication required) — surface as error so the UI can prompt.
      throw new Error('Failed to fetch page');
    },
    // Don't retry on 404 or 403 (resolved inside queryFn — those don't throw).
    retry: (failureCount, error) => {
      if (error.message === 'Failed to fetch page') {
        return failureCount < 3;
      }
      return false;
    },
    // Enable query only when we have either path or page_id.
    enabled: Boolean(params.path || params.page_id),
    // Avoid refetching on every navigation / window focus — page detail
    // mutations call `invalidateQueries({ queryKey: pageKeys.all })` so the
    // cache stays correct, and a 30 s window is fine for read-only nav.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

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
