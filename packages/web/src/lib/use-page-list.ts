'use client';

import type { ListPagesRequest } from '@crowi/api-contract';
import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

/**
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.listPages`
 * (ts-rest) to `apiClientV2.pages.list.$get` (hc<AppType>). Query
 * params are coerced to strings on the wire because hc's typed query
 * forwards verbatim; Zod's `z.coerce.number()` / `z.coerce.boolean()`
 * on the server side handles the conversion.
 */
interface UsePageListOptions {
  /** When false, skip the request entirely (react-query enabled flag). */
  enabled?: boolean;
}

export function usePageList(params: ListPagesRequest, options: UsePageListOptions = {}) {
  return useQuery({
    queryKey: ['pages', 'list', params],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const response = await apiClientV2.pages.list.$get({
        query: {
          path: params.path,
          user: params.user,
          limit: params.limit !== undefined ? String(params.limit) : undefined,
          offset: params.offset !== undefined ? String(params.offset) : undefined,
          include_deleted: params.include_deleted !== undefined ? String(params.include_deleted) : undefined,
        },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch page list');
      }
      return await response.json();
    },
  });
}
