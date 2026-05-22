'use client';

import { apiClientV2 } from './api-client';
import { createAdminSettingsHooks } from './admin-settings-factory';
import type { SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';

export const adminSecurityKeys = {
  all: ['admin', 'security'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.security.*`
 * (ts-rest) to `apiClientV2.admin.security.$method` (hc<AppType>). Wire
 * payload unchanged.
 */
const hooks = createAdminSettingsHooks<SecuritySettings, UpdateSecuritySettingsRequest>({
  queryKey: adminSecurityKeys.all,
  fetch: () => apiClientV2.admin.security.$get(),
  update: (body) => apiClientV2.admin.security.$put({ json: body }),
  fetchErrorMessage: 'Failed to fetch security settings',
  updateErrorMessage: 'Failed to update security settings',
});

export const useAdminSecuritySettings = hooks.useGet;
export const useUpdateAdminSecuritySettings = hooks.useUpdate;
