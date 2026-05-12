'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetSearchStatusResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

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
 */
export function useAdminSearch() {
  return useQuery<GetSearchStatusResponse, Error>({
    queryKey: adminSearchKeys.status(),
    queryFn: async () => {
      const result = await apiClient.admin.search.getSearchStatus();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: 'Failed to fetch search status', 403: 'Failed to fetch search status' },
        fallback: 'Failed to fetch search status',
      });
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
