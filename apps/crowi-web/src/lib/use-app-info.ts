'use client';

import { useQuery } from '@tanstack/react-query';
import type { AppInfoResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

export const appInfoKeys = {
  all: ['app', 'info'] as const,
};

export function useAppInfo() {
  return useQuery<AppInfoResponse, Error>({
    queryKey: appInfoKeys.all,
    queryFn: async () => {
      const result = await apiClient.app.getInfo();
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to fetch app info',
      });
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
