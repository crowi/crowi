'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetStorageStatusResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

/**
 * Query key factory for the /admin/storage endpoint. Wrapped in the
 * standard `<feature>Keys = { all }` shape so future invalidations
 * (e.g. after a switch or a drive list refresh) have a consistent
 * handle.
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
 */
export function useAdminStorage() {
  return useQuery<GetStorageStatusResponse, Error>({
    queryKey: adminStorageKeys.status(),
    queryFn: async () => {
      const result = await apiClient.admin.storage.getStorageStatus();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: 'Failed to fetch storage status', 403: 'Failed to fetch storage status' },
        fallback: 'Failed to fetch storage status',
      });
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
