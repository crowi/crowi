'use client';

import { apiClientV2 } from './api-client';
import { createAdminSettingsHooks } from './admin-settings-factory';
import { appInfoKeys } from './use-app-info';
import type { SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';

export const adminSecurityKeys = {
  all: ['admin', 'security'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.security.*`
 * (ts-rest) to `apiClientV2.admin.security.$method` (`createClient`). Wire
 * payload unchanged.
 *
 * feature-renderer-plugin-boundary Phase 3 — a successful PUT
 * invalidates the shared `useAppInfo()` query (`appInfoKeys.all`) so the
 * `link-card` capability (and therefore the editor affordance / preview
 * gating that reads it) picks up a `linkCardEnabled` flip immediately,
 * spec §6.3.
 */
const hooks = createAdminSettingsHooks<SecuritySettings, UpdateSecuritySettingsRequest>({
  queryKey: adminSecurityKeys.all,
  fetch: () => apiClientV2.admin.security.$get(),
  update: (body) => apiClientV2.admin.security.$put({ json: body }),
  fetchErrorMessage: 'Failed to fetch security settings',
  updateErrorMessage: 'Failed to update security settings',
  onUpdateSuccess: (_data, queryClient) => {
    queryClient.invalidateQueries({ queryKey: appInfoKeys.all });
  },
});

export const useAdminSecuritySettings = hooks.useGet;
export const useUpdateAdminSecuritySettings = hooks.useUpdate;
