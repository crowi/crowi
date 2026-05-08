'use client';

import { apiClient } from './api-client';
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

const hooks = createAdminSettingsHooks<AuthSettings, UpdateAuthSettingsRequest>({
  queryKey: adminAuthKeys.all,
  fetch: () => apiClient.admin.auth.getAuthSettings(),
  update: (body) => apiClient.admin.auth.updateAuthSettings({ body }),
  fetchErrorMessage: 'Failed to fetch auth settings',
  updateErrorMessage: 'Failed to update auth settings',
  mapValidationError: (body) => new AdminAuthSettingsValidationError(body.error.message),
});

export const useAdminAuthSettings = hooks.useGet;
export const useUpdateAdminAuthSettings = hooks.useUpdate;
