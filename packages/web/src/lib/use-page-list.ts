'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { ListPagesRequest } from '@crowi/api-contract';

export function usePageList(params: ListPagesRequest) {
  return useQuery({
    queryKey: ['pages', 'list', params],
    queryFn: async () => {
      const result = await apiClient.page.listPages({ query: params });
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to fetch page list',
      });
    },
  });
}
