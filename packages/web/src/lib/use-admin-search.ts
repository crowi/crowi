'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetSearchStatusResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';

/**
 * Query key factory for the /admin/search endpoint. Wrapped in the
 * standard `<feature>Keys = { all }` shape so future invalidations
 * have a consistent handle.
 */
export const adminSearchKeys = {
  all: ['admin', 'search'] as const,
  status: () => ['admin', 'search', 'status'] as const,
};

/**
 * Fetch the current search state: which driver is active and which
 * drivers are installed. Read-only — driver switching is
 * `crowi.config.json` + restart, and full-index rebuild runs through
 * the `crowi-admin search rebuild` CLI subcommand. Both intentionally
 * bypass HTTP (long rebuilds shouldn't tie up an admin request, and
 * rebuild semantics are plugin-defined).
 *
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.search.*`
 * to `apiClientV2.admin.search.$get` (hc<AppType>).
 */
export function useAdminSearch() {
  return useQuery<GetSearchStatusResponse, Error>({
    queryKey: adminSearchKeys.status(),
    queryFn: async () => {
      const response = await apiClientV2.admin.search.$get();
      if (response.status === 200) {
        return (await response.json()) as GetSearchStatusResponse;
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? 'Failed to fetch search status');
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
