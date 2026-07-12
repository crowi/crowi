'use client';

import type { ListPagesRequest } from '@crowi/api-contract';
import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import { pageListKeys } from './page-query-keys';

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

// `sort` / `order` carry server-side defaults, so callers that don't care
// about ordering (e.g. the rename-dialog descendant probe) may omit them.
//
// Exported so `page-query-keys.ts` can type `pageListKeys.detail` against
// this hook's actual params — the key factory lives in the registry, but
// this type stays the source of truth here.
export type UsePageListParams = Omit<ListPagesRequest, 'sort' | 'order'> & Partial<Pick<ListPagesRequest, 'sort' | 'order'>>;

export function usePageList(params: UsePageListParams, options: UsePageListOptions = {}) {
  return useQuery({
    queryKey: pageListKeys.detail(params),
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const response = await apiClientV2.pages.list.$get({
        query: {
          path: params.path,
          user: params.user,
          limit: params.limit !== undefined ? String(params.limit) : undefined,
          offset: params.offset !== undefined ? String(params.offset) : undefined,
          include_deleted: params.include_deleted !== undefined ? String(params.include_deleted) : undefined,
          sort: params.sort,
          order: params.order,
          revision_id: params.revision_id,
        },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch page list');
      }
      return await response.json();
    },
  });
}
