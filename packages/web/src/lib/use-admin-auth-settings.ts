'use client';

import { apiClientV2 } from './api-client';
import { createAdminSettingsHooks } from './admin-settings-factory';
import type { AuthSettings, UpdateAuthSettingsRequest } from '@crowi/api-contract';

export const adminAuthKeys = {
  all: ['admin', 'auth'] as const,
};

/**
 * Error subclass surfaced by `useUpdateAdminAuthSettings` when the API rejects
 * the update with the self-lockout guard (422 PASSWORD_AUTH_REQUIRES_THIRDPARTY).
 *
 * The form layer can pattern-match on `code` to render a more specific UI
 * (e.g. point the operator at /admin/google or /admin/github) without
 * relying on the localised message string.
 */
export class AdminAuthSettingsValidationError extends Error {
  readonly code: 'PASSWORD_AUTH_REQUIRES_THIRDPARTY';

  constructor(message: string) {
    super(message);
    this.name = 'AdminAuthSettingsValidationError';
    this.code = 'PASSWORD_AUTH_REQUIRES_THIRDPARTY';
  }
}

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.auth.*`
 * (ts-rest) to `apiClientV2.admin.auth.$method` (hc<AppType>). Wire
 * payload unchanged. The 422 envelope still triggers
 * `AdminAuthSettingsValidationError`.
 */
const hooks = createAdminSettingsHooks<AuthSettings, UpdateAuthSettingsRequest>({
  queryKey: adminAuthKeys.all,
  fetch: () => apiClientV2.admin.auth.$get(),
  update: (body) => apiClientV2.admin.auth.$put({ json: body }),
  fetchErrorMessage: 'Failed to fetch auth settings',
  updateErrorMessage: 'Failed to update auth settings',
  mapValidationError: (body) => new AdminAuthSettingsValidationError(body.error.message),
});

export const useAdminAuthSettings = hooks.useGet;
export const useUpdateAdminAuthSettings = hooks.useUpdate;
