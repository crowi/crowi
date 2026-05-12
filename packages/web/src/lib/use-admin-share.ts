'use client';

import { apiClient } from './api-client';
import { adminAppSettingsKeys } from './use-admin-app-settings';
import { createAdminSettingsHooks } from './admin-settings-factory';
import type { ShareSettings, UpdateShareSettingsRequest } from '@crowi/api-contract';

export const adminShareKeys = {
  all: ['admin', 'share'] as const,
};

const hooks = createAdminSettingsHooks<ShareSettings, UpdateShareSettingsRequest>({
  queryKey: adminShareKeys.all,
  fetch: () => apiClient.admin.share.getShareSettings(),
  update: (body) => apiClient.admin.share.updateShareSettings({ body }),
  fetchErrorMessage: 'Failed to fetch share settings',
  updateErrorMessage: 'Failed to update share settings',
  // Cross-cache: the App settings page surfaces externalShare as a
  // read-only status badge — flipping the toggle here should be reflected
  // there without a manual refresh.
  onUpdateSuccess: (_data, queryClient) => {
    queryClient.invalidateQueries({ queryKey: adminAppSettingsKeys.settings });
  },
});

export const useAdminShareSettings = hooks.useGet;
export const useUpdateAdminShareSettings = hooks.useUpdate;
