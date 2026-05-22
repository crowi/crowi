'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

export const installerStatusKeys = {
  all: ['installer', 'status'] as const,
};

/**
 * `GET /installer` — migrated from ts-rest to Hono in RFC-0006 Phase 4
 * Batch 1. The wire payload is unchanged (`{ status: 'installer_required'
 * | 'already_installed' }`), so the consumer-facing return type stays
 * the same; we just call the `hc<AppType>` client instead of the legacy
 * `apiClient.installer.getStatus()` and check `response.ok` directly.
 */
export function useInstallerStatus() {
  return useQuery({
    queryKey: installerStatusKeys.all,
    queryFn: async () => {
      const response = await apiClientV2.installer.$get();
      if (!response.ok) {
        throw new Error('Failed to fetch installer status');
      }
      return response.json();
    },
    // Installation is a one-time, irreversible event; never refetch within a session.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
