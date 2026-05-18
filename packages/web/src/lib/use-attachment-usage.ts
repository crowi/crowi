'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { attachmentsKeys } from './use-attachments';
import type { AttachmentUsageResponse } from '@crowi/api-contract';

/**
 * Phase 8 — fetch the full attachment usage breakdown (latest vs
 * past-only) for a page. Backs the `/_attachments?pageId=` page.
 *
 * Unlike `useAttachmentList`, errors are surfaced (not swallowed into an
 * empty list): `/_attachments` is a dedicated page, so a failed fetch
 * should render an error rather than a deceptively empty view.
 */
export function useAttachmentUsage(pageId: string | undefined) {
  return useQuery({
    queryKey: pageId ? attachmentsKeys.usage(pageId) : attachmentsKeys.all,
    queryFn: async (): Promise<AttachmentUsageResponse> => {
      if (!pageId) throw new Error('pageId is required');
      const result = await apiClient.attachment.getAttachmentUsage({ params: { pageId } });
      if (result.status !== 200) {
        const body = result.body as { error?: { message?: string } } | undefined;
        throw new Error(body?.error?.message ?? 'Failed to load attachments');
      }
      return result.body;
    },
    enabled: !!pageId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}
