'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { GetAppSettingsResponse, UpdateAppSettingsRequest, UpdateAppSettingsResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminAppSettingsKeys = {
  settings: ['admin-app-settings'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.app.*`
 * (ts-rest) to `apiClient.admin.app.$method` (`createClient`). Wire
 * payload unchanged. 401 / 403 collapse to `null` so the admin layout
 * gates the redirect.
 */
export function useAppSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminAppSettingsKeys.settings,
    queryFn: async (): Promise<GetAppSettingsResponse | null> => {
      const response = await apiClient.admin.app.$get();
      if (response.status !== 200) return null;
      return (await response.json()) as GetAppSettingsResponse;
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
    super(m['admin.common.field_errors_summary']());
    this.name = 'AppSettingsValidationFailure';
    this.fieldErrors = fieldErrors;
  }
}

interface AppSettingsValidationBody {
  bodyResult?: { issues?: { path: (string | number)[]; message: string }[] };
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateAppSettingsRequest): Promise<UpdateAppSettingsResponse> => {
      const response = await apiClient.admin.app.$put({ json: body });
      if (response.status === 200) return (await response.json()) as UpdateAppSettingsResponse;
      if (response.status === 400) {
        const parsed = (await response.json().catch(() => null)) as AppSettingsValidationBody | null;
        const fieldErrors: Record<string, string> = {};
        const issues = parsed?.bodyResult?.issues ?? [];
        for (const issue of issues) {
          const key = issue.path.map(String).join('.');
          if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
        }
        throw new AppSettingsValidationFailure(fieldErrors);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['admin.app.failed_to_save']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminAppSettingsKeys.settings });
      // Site title flows into the header via useAppInfo(); refetch so the
      // change appears immediately instead of waiting for a hard reload.
      queryClient.invalidateQueries({ queryKey: ['app', 'info'] });
    },
  });
}
