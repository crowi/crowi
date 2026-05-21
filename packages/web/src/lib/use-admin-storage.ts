'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetStorageStatusResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';

/**
 * Query key factory for the /admin/storage endpoint.
 */
export const adminStorageKeys = {
  all: ['admin', 'storage'] as const,
  status: () => ['admin', 'storage', 'status'] as const,
};

/**
 * Fetch the current storage state: which driver is active and which
 * drivers are installed. Read-only — no mutation hook because driver
 * switching is `crowi.config.json` + restart, not a runtime config
 * write. See `.feature-state/specs/feature-admin-storage.md`.
 *
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.storage.*`
 * to `apiClientV2.admin.storage.$get` (hc<AppType>).
 */
export function useAdminStorage() {
  return useQuery<GetStorageStatusResponse, Error>({
    queryKey: adminStorageKeys.status(),
    queryFn: async () => {
      const response = await apiClientV2.admin.storage.$get();
      if (response.status === 200) {
        return (await response.json()) as GetStorageStatusResponse;
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? 'Failed to fetch storage status');
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
