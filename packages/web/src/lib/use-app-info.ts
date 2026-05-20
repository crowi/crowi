'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

export const appInfoKeys = {
  all: ['app', 'info'] as const,
};

export function useAppInfo() {
  return useQuery({
    queryKey: appInfoKeys.all,
    queryFn: async () => {
      const response = await apiClientV2.app.info.$get();
      if (!response.ok) {
        throw new Error('Failed to fetch app info');
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
