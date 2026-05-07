'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';

export const adminSecurityKeys = {
  all: ['admin', 'security'] as const,
};

/**
 * Fetch the current security:* admin settings. Surfaces standard ts-rest
 * status discrimination — non-200 responses (401/403/500) are thrown as
 * Errors so callers can rely on `data` always being SecuritySettings.
 *
 * 401/403 normally never reach this hook in practice (the AdminLayout
 * guards on `user.admin`), but we still propagate them as errors instead
 * of swallowing to surface backend regressions.
 */
export function useAdminSecuritySettings() {
  return useQuery({
    queryKey: adminSecurityKeys.all,
    queryFn: async (): Promise<SecuritySettings> => {
      const result = await apiClient.admin.security.getSecuritySettings();
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to fetch security settings');
    },
    // Admin settings rarely change; mutations invalidate explicitly via
    // setQueryData. No need to re-hit the API on every focus regain.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Persist updates to the security:* settings. The PUT endpoint returns the
 * post-save settings, which we use to seed the cache directly so the UI does
 * not need a follow-up GET.
 */
export function useUpdateAdminSecuritySettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateSecuritySettingsRequest): Promise<SecuritySettings> => {
      const result = await apiClient.admin.security.updateSecuritySettings({ body: data });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to update security settings');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(adminSecurityKeys.all, data);
    },
  });
}
