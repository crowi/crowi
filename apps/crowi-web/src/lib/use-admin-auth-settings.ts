'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
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
 * Fetch the current auth:* admin settings. Mirrors the `useAdminSecuritySettings`
 * shape: non-200 responses (401/403/500) are thrown as Errors so callers can
 * rely on `data` always being AuthSettings.
 */
export function useAdminAuthSettings() {
  return useQuery({
    queryKey: adminAuthKeys.all,
    queryFn: async (): Promise<AuthSettings> => {
      const result = await apiClient.admin.auth.getAuthSettings();
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to fetch auth settings');
    },
    // Admin settings rarely change; mutations invalidate explicitly via
    // setQueryData. No need to re-hit the API on every focus regain.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Persist updates to the auth:* settings.
 *
 * 422 (the self-lockout guard) is surfaced as `AdminAuthSettingsValidationError`
 * so the form can show a tailored message; other non-200 responses fall back
 * to a generic Error.
 */
export function useUpdateAdminAuthSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateAuthSettingsRequest): Promise<AuthSettings> => {
      const result = await apiClient.admin.auth.updateAuthSettings({ body: data });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 422) {
        throw new AdminAuthSettingsValidationError(result.body.error.message);
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to update auth settings');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(adminAuthKeys.all, data);
    },
  });
}
