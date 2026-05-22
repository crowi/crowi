'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import { attachmentsKeys } from './use-attachments';
import type { AttachmentUsageResponse } from '@crowi/api-contract';

/**
 * Phase 8 — fetch the full attachment usage breakdown (latest vs
 * past-only) for a page. Backs the `/_attachments?pageId=` page.
 *
 * Unlike `useAttachmentList`, errors are surfaced (not swallowed into an
 * empty list): `/_attachments` is a dedicated page, so a failed fetch
 * should render an error rather than a deceptively empty view.
 *
 * RFC-0006 Phase 4 Batch 6 — switched from `apiClient.attachment.*`
 * (ts-rest) to `apiClientV2.pages[':pageId'].attachments.usage.$get`
 * (hc<AppType>).
 */
export function useAttachmentUsage(pageId: string | undefined) {
  return useQuery({
    queryKey: pageId ? attachmentsKeys.usage(pageId) : attachmentsKeys.all,
    queryFn: async (): Promise<AttachmentUsageResponse> => {
      if (!pageId) throw new Error('pageId is required');
      const response = await apiClientV2.pages[':pageId'].attachments.usage.$get({ param: { pageId } });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Failed to load attachments');
      }
      return (await response.json()) as AttachmentUsageResponse;
    },
    enabled: !!pageId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}
