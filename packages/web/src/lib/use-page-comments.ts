'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { Comment } from '@crowi/api-contract';

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

export function usePageCommentsList(pageId: string | null | undefined) {
  const query = useQuery({
    queryKey: pageId ? commentKeys.detail(pageId) : commentKeys.all,
    queryFn: async () => {
      if (!pageId) return [] as Comment[];
      const result = await apiClient.comment.listComments({ query: { page_id: pageId } });
      return unwrapResult(result, {
        ok: (body) => body.comments,
        fallback: 'Failed to fetch comments',
      });
    },
    enabled: Boolean(pageId),
    // Comments rarely change after a page is rendered; avoid the focus-refetch
    // storm by holding the cache for 30s. Mutations invalidate explicitly.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
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
      const result = await apiClient.comment.addComment({
        body: {
          page_id: pageId,
          revision_id: input.revisionId,
          comment: input.comment,
          comment_position: input.commentPosition,
        },
      });
      return unwrapResult(result, {
        ok: (body) => body.comment,
        errors: { 400: 'Failed to add comment', 403: 'Failed to add comment', 404: 'Failed to add comment' },
        fallback: 'Failed to add comment',
      });
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
      const result = await apiClient.comment.deleteComment({
        body: { comment_id: commentId, page_id: pageId },
      });
      return unwrapResult(result, {
        ok: () => true,
        errors: { 400: 'Failed to delete comment', 403: 'Failed to delete comment', 404: 'Failed to delete comment' },
        fallback: 'Failed to delete comment',
      });
    },
    onSuccess: () => invalidate(),
  });

  return {
    deleteComment: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  };
}
