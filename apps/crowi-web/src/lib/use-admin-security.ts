'use client';

import { apiClient } from './api-client';
import { createAdminSettingsHooks } from './admin-settings-factory';
import type { SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';

export const adminSecurityKeys = {
  all: ['admin', 'security'] as const,
};

const hooks = createAdminSettingsHooks<SecuritySettings, UpdateSecuritySettingsRequest>({
  queryKey: adminSecurityKeys.all,
  fetch: () => apiClient.admin.security.getSecuritySettings(),
  update: (body) => apiClient.admin.security.updateSecuritySettings({ body }),
  fetchErrorMessage: 'Failed to fetch security settings',
  updateErrorMessage: 'Failed to update security settings',
});

export const useAdminSecuritySettings = hooks.useGet;
export const useUpdateAdminSecuritySettings = hooks.useUpdate;
