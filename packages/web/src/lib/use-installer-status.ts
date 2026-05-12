'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

export const installerStatusKeys = {
  all: ['installer', 'status'] as const,
};

export function useInstallerStatus() {
  return useQuery({
    queryKey: installerStatusKeys.all,
    queryFn: async () => {
      const result = await apiClient.installer.getStatus();
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to fetch installer status',
      });
    },
    // Installation is a one-time, irreversible event; never refetch within a session.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
