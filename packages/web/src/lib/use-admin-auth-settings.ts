'use client';

import { useQuery } from '@tanstack/react-query';

import { apiClient } from './api-client';
import type { AuthSettings } from '@crowi/api-contract';

export const adminAuthKeys = {
  all: ['admin', 'auth'] as const,
};

/**
 * GET /admin/auth — read the two inert `auth:*` toggles.
 *
 * There is no write hook: third-party sign-in was removed from core in the
 * 2.0.0-alpha line, so both `requireThirdPartyAuth` / `disablePasswordAuth`
 * are permanently rejected by the API (400 `THIRD_PARTY_AUTH_UNAVAILABLE`) and
 * the admin form renders them read-only. A write path returns when an auth
 * provider plugin is installed.
 */
export function useAdminAuthSettings() {
  return useQuery<AuthSettings, Error>({
    queryKey: adminAuthKeys.all,
    queryFn: async () => {
      const response = await apiClient.admin.auth.$get();
      if (response.status === 200) {
        return (await response.json()) as AuthSettings;
      }
      throw new Error('Failed to fetch auth settings');
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
