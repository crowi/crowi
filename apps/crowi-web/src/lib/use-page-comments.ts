'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Comment } from '@crowi/api-contract';

export const commentKeys = {
  all: ['comments'] as const,
  detail: (pageId: string) => ['comments', { pageId }] as const,
};

/**
 * Invalidate the comment list and the page query after a comment mutation.
 * The page query is invalidated because the page header's commentCount is
 * updated by an async post-save hook on the Comment model.
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
      if (result.status === 200) {
        return result.body.comments;
      }
      throw new Error('Failed to fetch comments');
    },
    enabled: Boolean(pageId),
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
      if (result.status === 200) {
        return result.body.comment;
      }
      const message = result.status === 400 || result.status === 404 || result.status === 403 ? result.body.error.message : 'Failed to add comment';
      throw new Error(message);
    },
    onSuccess: () => invalidate(),
  });

  return {
    addComment: mutation.mutateAsync,
    isAdding: mutation.isPending,
    addError: mutation.error as Error | null,
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
      if (result.status === 200) {
        return true;
      }
      const message = result.status === 400 || result.status === 404 || result.status === 403 ? result.body.error.message : 'Failed to delete comment';
      throw new Error(message);
    },
    onSuccess: () => invalidate(),
  });

  return {
    deleteComment: mutation.mutateAsync,
    isDeleting: mutation.isPending,
  };
}
