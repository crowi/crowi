'use client';

import { apiClientV2 } from './api-client';
import { adminAppSettingsKeys } from './use-admin-app-settings';
import { createAdminSettingsHooks } from './admin-settings-factory';
import type { ShareSettings, UpdateShareSettingsRequest } from '@crowi/api-contract';

export const adminShareKeys = {
  all: ['admin', 'share'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.share.*`
 * (ts-rest) to `apiClientV2.admin.share.$method` (hc<AppType>). Wire
 * payload unchanged. Factory converts the Response envelope to the
 * standard ApiResult-style state on the query layer.
 */
const hooks = createAdminSettingsHooks<ShareSettings, UpdateShareSettingsRequest>({
  queryKey: adminShareKeys.all,
  fetch: () => apiClientV2.admin.share.$get(),
  update: (body) => apiClientV2.admin.share.$put({ json: body }),
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
