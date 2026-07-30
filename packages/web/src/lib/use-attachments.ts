'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, apiBaseUrl } from './api-client';
import { getAccessToken } from './auth-token';
import type { Attachment, AttachmentMeta, ListAttachmentsResponse } from '@crowi/api-contract';

/**
 * RFC-0006 Phase 4 Batch 6 — switched from `apiClient.attachment.*`
 * (ts-rest) to `apiClient.pages[':pageId'].attachments.*` /
 * `apiClient.attachments[':id'].*` (`createClient`). Wire payload is
 * unchanged. `useAddAttachment` continues to use a bare `fetch` for the
 * multipart upload because `apiClient`'s `$post` does not surface
 * `XMLHttpRequest`-style upload progress and the existing code path is
 * already a hand-rolled fetch.
 */
export const attachmentsKeys = {
  all: ['attachments'] as const,
  list: (pageId: string) => ['attachments', pageId] as const,
  usage: (pageId: string) => ['attachments', pageId, 'usage'] as const,
  detail: (id: string) => ['attachments', 'detail', id] as const,
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
      const response = await apiClient.pages[':pageId'].attachments.$get({ param: { pageId } });
      if (response.ok) {
        return (await response.json()) as ListAttachmentsResponse;
      }
      return { attachments: [] };
    },
    enabled: !!pageId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch metadata for a single attachment by id (`GET /attachments/:id/meta`).
 *
 * Backs the in-body attachment modal: a `/api/attachments/<id>` link or
 * embed in a page body carries only the id. The `attachmentsKeys.detail(id)`
 * cache key dedupes repeated body references — a page that embeds the same
 * attachment twice fetches its metadata once. `staleTime` is generous
 * because attachment metadata (name / size / type) is effectively immutable.
 *
 * `enabled` is gated on `id` so the hook can be mounted unconditionally with
 * a not-yet-resolved id.
 */
export function useAttachment(id: string | undefined) {
  return useQuery({
    queryKey: attachmentsKeys.detail(id ?? ''),
    queryFn: async (): Promise<AttachmentMeta> => {
      if (!id) throw new Error('attachment id is required');
      const response = await apiClient.attachments[':id'].meta.$get({ param: { id } });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Failed to load attachment');
      }
      return (await response.json()) as AttachmentMeta;
    },
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Upload a file as an attachment of `pageId`. Hand-rolled `fetch` rather
 * than going through the typed client because `apiClient`'s `$post`
 * does not currently surface upload progress; this fetch keeps the auth /
 * refresh behaviour aligned with the rest of the app by reading the
 * access token from `auth-token`.
 */
export function useAddAttachment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<Attachment> => {
      if (!pageId) throw new Error('pageId is required to upload an attachment');

      const formData = new FormData();
      formData.append('file', file);

      const accessToken = getAccessToken();
      const response = await fetch(`${apiBaseUrl()}/pages/${encodeURIComponent(pageId)}/attachments`, {
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
      const response = await apiClient.attachments[':id'].$delete({ param: { id: attachmentId } });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Failed to remove attachment');
      }
    },
    onSuccess: () => {
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: attachmentsKeys.list(pageId) });
        return;
      }
      // pageId unknown: refresh every `['attachments', <pageId>]` list but
      // skip the `detail(id)` and `usage(pageId)` caches (deleting an
      // attachment doesn't change another page's usage, and a 404 on the
      // deleted detail is the right next observation).
      queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'attachments' && typeof q.queryKey[1] === 'string' && q.queryKey[1] !== 'detail' && q.queryKey[2] !== 'usage',
      });
    },
  });
}
