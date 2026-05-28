'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { Comment } from '@crowi/api-contract';

/**
 * RFC-0006 Phase 4 Batch 3 — switched from `apiClient.comment.*`
 * (ts-rest) to `apiClientV2.comments.$method` (hc<AppType>). The wire
 * payload (`{ comments }`, `{ comment }`, `{ ok: true }`) is preserved.
 * Error envelopes (`{ error: { code, message } }`) are mapped through
 * `extractErrorMessage` so users see the server's intended message
 * when available, falling back to a generic verb.
 */
export const commentKeys = {
  all: ['comments'] as const,
  detail: (pageId: string) => ['comments', { pageId }] as const,
};

/**
 * The page query is invalidated alongside the comment list because the page
 * header's commentCount is updated by an async post-save hook on the Comment
 * model — refetching the page is the cheapest way to keep that count fresh.
 */
function useInvalidateComments(pageId: string | null | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (!pageId) return;
    queryClient.invalidateQueries({ queryKey: commentKeys.detail(pageId) });
    queryClient.invalidateQueries({ queryKey: ['page'] });
  };
}

const extractErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message || fallback;
  } catch {
    return fallback;
  }
};

export function usePageCommentsList(pageId: string | null | undefined) {
  const query = useQuery({
    queryKey: pageId ? commentKeys.detail(pageId) : commentKeys.all,
    queryFn: async () => {
      if (!pageId) return [] as Comment[];
      const response = await apiClientV2.comments.$get({ query: { page_id: pageId } });
      if (response.ok) {
        const body = await response.json();
        return body.comments;
      }
      throw new Error(await extractErrorMessage(response, 'Failed to fetch comments'));
    },
    enabled: Boolean(pageId),
    // Hold the cache for 30s to dedupe observers within a single page
    // view, but always refetch when the component remounts: revisiting a
    // page (e.g. via a comment notification after navigating away) must
    // show comments added in the meantime, which a stale cache hit would
    // hide. Window-focus refetch stays off to avoid a refetch storm.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export function useAddComment(pageId: string | null | undefined) {
  const invalidate = useInvalidateComments(pageId);

  const mutation = useMutation({
    mutationFn: async (input: { revisionId: string; comment: string; commentPosition?: number }) => {
      if (!pageId) throw new Error('pageId is required');
      const response = await apiClientV2.comments.$post({
        json: {
          page_id: pageId,
          revision_id: input.revisionId,
          comment: input.comment,
          comment_position: input.commentPosition,
        },
      });
      if (response.ok) {
        const body = await response.json();
        return body.comment;
      }
      throw new Error(await extractErrorMessage(response, 'Failed to add comment'));
    },
    onSuccess: () => invalidate(),
  });

  return {
    addComment: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

export function useDeleteComment(pageId: string | null | undefined) {
  const invalidate = useInvalidateComments(pageId);

  const mutation = useMutation({
    mutationFn: async (commentId: string) => {
      if (!pageId) throw new Error('pageId is required');
      const response = await apiClientV2.comments.$delete({
        json: { comment_id: commentId, page_id: pageId },
      });
      if (response.ok) return true;
      throw new Error(await extractErrorMessage(response, 'Failed to delete comment'));
    },
    onSuccess: () => invalidate(),
  });

  return {
    deleteComment: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  };
}
