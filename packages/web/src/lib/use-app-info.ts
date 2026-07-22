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

/**
 * Derives the `link-card` embed capability (feature-renderer-plugin-
 * boundary Phase 3, admin Security `security:linkCardEnabled` toggle)
 * from the shared app-info query. Defaults to `true` while the query
 * is loading / errored — same optimistic default-on the toggle itself
 * uses server-side — so every call site that gates the editor's
 * link-card affordance sees identical behavior off one definition.
 */
export function useLinkCardEnabled(): boolean {
  return useAppInfo().data?.capabilities.includes('link-card') ?? true;
}
