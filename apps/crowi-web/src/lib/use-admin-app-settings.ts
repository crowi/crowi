'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { GetAppSettingsResponse, UpdateAppSettingsRequest, UpdateAppSettingsResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminAppSettingsKeys = {
  settings: ['admin-app-settings'] as const,
};

export function useAppSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminAppSettingsKeys.settings,
    queryFn: async (): Promise<GetAppSettingsResponse | null> => {
      const result = await apiClient.admin.app.getAppSettings();
      if (result.status === 200) return result.body;
      // 401/403: caller (admin layout) handles gating; surface as null.
      return null;
    },
    enabled: options?.enabled !== false,
    // The admin form is the only writer for these values; mutation invalidates
    // explicitly. 5 min matches useAdminSecuritySettings — admin settings
    // change less often than the cache freshness we'd save by polling.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export class AppSettingsValidationFailure extends Error {
  /** Per-field issues from the server-side Zod parse. Keys are dotted paths
   * such as `app.title` so the form can map them onto the matching input. */
  public readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super(m['admin.app.field_errors_summary']());
    this.name = 'AppSettingsValidationFailure';
    this.fieldErrors = fieldErrors;
  }
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateAppSettingsRequest): Promise<UpdateAppSettingsResponse> => {
      const result = await apiClient.admin.app.updateAppSettings({ body });
      if (result.status === 200) return result.body;
      if (result.status === 400) {
        const fieldErrors: Record<string, string> = {};
        const issues = result.body?.bodyResult?.issues ?? [];
        for (const issue of issues) {
          const key = issue.path.map(String).join('.');
          if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
        }
        throw new AppSettingsValidationFailure(fieldErrors);
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['admin.app.failed_to_save']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminAppSettingsKeys.settings });
    },
  });
}
