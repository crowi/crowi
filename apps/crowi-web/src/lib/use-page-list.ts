'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { ListPagesRequest } from '@crowi/api-contract';

export function usePageList(params: ListPagesRequest) {
  return useQuery({
    queryKey: ['pages', 'list', params],
    queryFn: async () => {
      const result = await apiClient.page.listPages({ query: params });
      if (result.status === 200) {
        return result.body;
      }
      throw new Error('Failed to fetch page list');
    },
  });
}
