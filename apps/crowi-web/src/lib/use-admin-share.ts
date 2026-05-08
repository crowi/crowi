'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { adminAppSettingsKeys } from './use-admin-app-settings';
import type { ShareSettings, UpdateShareSettingsRequest } from '@crowi/api-contract';

export const adminShareKeys = {
  all: ['admin', 'share'] as const,
};

/**
 * Fetch the current share-related admin settings (just the externalShare
 * toggle for now). 401/403 normally never reach this hook in practice — the
 * AdminLayout guards on `user.admin` — but we still propagate them as
 * Errors to surface backend regressions instead of silently returning
 * stale/empty data.
 */
export function useAdminShareSettings() {
  return useQuery({
    queryKey: adminShareKeys.all,
    queryFn: async (): Promise<ShareSettings> => {
      const result = await apiClient.admin.share.getShareSettings();
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to fetch share settings');
    },
    // Admin settings rarely change; mutation invalidates explicitly via
    // setQueryData. Match the cache freshness used by other admin hooks.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Persist updates to the share settings. The PUT endpoint returns the
 * post-save settings, which we use to seed this hook's cache directly so
 * the UI does not need a follow-up GET.
 *
 * Also invalidates `adminAppSettingsKeys.settings` because the App settings
 * page surfaces `externalShare` as a read-only status badge — flipping the
 * toggle here should be reflected there without a manual refresh.
 */
export function useUpdateAdminShareSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateShareSettingsRequest): Promise<ShareSettings> => {
      const result = await apiClient.admin.share.updateShareSettings({ body: data });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to update share settings');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(adminShareKeys.all, data);
      // Keep the App settings page in sync — its `externalShare` status row
      // reads from a different query key (`adminAppSettingsKeys.settings`).
      queryClient.invalidateQueries({ queryKey: adminAppSettingsKeys.settings });
    },
  });
}
