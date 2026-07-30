'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { GetMailSettingsResponse, SendTestMailResponse, UpdateMailSettingsRequest, UpdateMailSettingsResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminMailSettingsKeys = {
  settings: ['admin-mail-settings'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.mail.*`
 * (ts-rest) to `apiClient.admin.mail.*.$method` (`createClient`). Wire
 * payload unchanged. The 400 `MailSettingsValidationError` envelope
 * (`{ bodyResult: { issues } }`) is still produced by the contract's
 * per-route hook override.
 */
export function useMailSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminMailSettingsKeys.settings,
    queryFn: async (): Promise<GetMailSettingsResponse | null> => {
      const response = await apiClient.admin.mail.$get();
      if (response.status !== 200) return null;
      return (await response.json()) as GetMailSettingsResponse;
    },
    enabled: options?.enabled !== false,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export class MailSettingsValidationFailure extends Error {
  public readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super(m['admin.common.field_errors_summary']());
    this.name = 'MailSettingsValidationFailure';
    this.fieldErrors = fieldErrors;
  }
}

interface MailSettingsValidationBody {
  bodyResult?: { issues?: { path: (string | number)[]; message: string }[] };
}

export function useUpdateMailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateMailSettingsRequest): Promise<UpdateMailSettingsResponse> => {
      const response = await apiClient.admin.mail.$put({ json: body });
      if (response.status === 200) return (await response.json()) as UpdateMailSettingsResponse;
      if (response.status === 400) {
        const parsed = (await response.json().catch(() => null)) as MailSettingsValidationBody | null;
        const fieldErrors: Record<string, string> = {};
        const issues = parsed?.bodyResult?.issues ?? [];
        for (const issue of issues) {
          const key = issue.path.map(String).join('.');
          if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
        }
        throw new MailSettingsValidationFailure(fieldErrors);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['admin.mail.failed_to_save']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminMailSettingsKeys.settings });
    },
  });
}

export function useSendTestMail() {
  return useMutation({
    mutationFn: async (): Promise<SendTestMailResponse> => {
      const response = await apiClient.admin.mail.test.$post({ json: {} });
      if (response.status === 200) return (await response.json()) as SendTestMailResponse;
      if (response.status === 502) {
        const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(parsed?.error?.message ?? m['admin.mail.test_failed']());
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['admin.mail.test_failed']());
    },
  });
}
