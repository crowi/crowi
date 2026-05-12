'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type {
  GetMailSettingsResponse,
  SendTestMailRequest,
  SendTestMailResponse,
  UpdateMailSettingsRequest,
  UpdateMailSettingsResponse,
} from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminMailSettingsKeys = {
  settings: ['admin-mail-settings'] as const,
};

export function useMailSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminMailSettingsKeys.settings,
    queryFn: async (): Promise<GetMailSettingsResponse | null> => {
      const result = await apiClient.admin.mail.getMailSettings();
      if (result.status === 200) return result.body;
      return null;
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

export function useUpdateMailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateMailSettingsRequest): Promise<UpdateMailSettingsResponse> => {
      const result = await apiClient.admin.mail.updateMailSettings({ body });
      if (result.status === 200) return result.body;
      if (result.status === 400) {
        const fieldErrors: Record<string, string> = {};
        const issues = result.body?.bodyResult?.issues ?? [];
        for (const issue of issues) {
          const key = issue.path.map(String).join('.');
          if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
        }
        throw new MailSettingsValidationFailure(fieldErrors);
      }
      if (result.status === 401 || result.status === 403) {
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
    mutationFn: async (body: SendTestMailRequest): Promise<SendTestMailResponse> => {
      const result = await apiClient.admin.mail.sendTestMail({ body });
      if (result.status === 200) return result.body;
      if (result.status === 502) {
        throw new Error(result.body?.error?.message ?? m['admin.mail.test_failed']());
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['admin.mail.test_failed']());
    },
  });
}
