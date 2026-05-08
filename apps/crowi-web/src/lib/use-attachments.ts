'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Attachment, ListAttachmentsResponse } from '@crowi/api-contract';

export const attachmentsKeys = {
  all: ['attachments'] as const,
  list: (pageId: string) => ['attachments', pageId] as const,
};

/**
 * Fetch attachments for a page. Errors fall back to an empty list — this is
 * auxiliary UI shown in the page footer and shouldn't break the page view.
 */
export function useAttachmentList(pageId: string | undefined) {
  return useQuery({
    queryKey: pageId ? attachmentsKeys.list(pageId) : attachmentsKeys.all,
    queryFn: async (): Promise<ListAttachmentsResponse> => {
      if (!pageId) return { attachments: [] };
      const result = await apiClient.attachment.listAttachments({ params: { pageId } });
      return result.status === 200 ? result.body : { attachments: [] };
    },
    enabled: !!pageId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Upload a file as an attachment of `pageId`. ts-rest's typed client does not
 * play nicely with multipart bodies, so we issue the fetch ourselves and
 * delegate auth-header / refresh to the shared apiClient by reading the
 * access token from localStorage (same source apiClient consults). We
 * prefer this over duplicating the refresh dance because uploads are rare
 * enough that an expired-token reload-and-retry is acceptable.
 */
export function useAddAttachment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<Attachment> => {
      if (!pageId) throw new Error('pageId is required to upload an attachment');

      const formData = new FormData();
      formData.append('file', file);

      const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

      const response = await fetch(`${baseUrl}/api/v2/pages/${encodeURIComponent(pageId)}/attachments`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        body: formData,
      });

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? ((body as { error: { message?: string } }).error?.message ?? 'Upload failed')
            : 'Upload failed';
        throw new Error(message);
      }
      return (body as { attachment: Attachment }).attachment;
    },
    onSuccess: () => {
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: attachmentsKeys.list(pageId) });
      }
    },
  });
}

export function useRemoveAttachment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (attachmentId: string): Promise<void> => {
      // ts-rest's typed client requires `body` in the call args even when the
      // contract's body schema is `z.unknown().optional()`. Pass undefined
      // explicitly — the underlying fetch sends no body for DELETE.
      const result = await apiClient.attachment.removeAttachment({ params: { id: attachmentId }, body: undefined });
      if (result.status !== 200) {
        const body = result.body as { error?: { message?: string } } | undefined;
        throw new Error(body?.error?.message ?? 'Failed to remove attachment');
      }
    },
    onSuccess: () => {
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: attachmentsKeys.list(pageId) });
      } else {
        queryClient.invalidateQueries({ queryKey: attachmentsKeys.all });
      }
    },
  });
}
