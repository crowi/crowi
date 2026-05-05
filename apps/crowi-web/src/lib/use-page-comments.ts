'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Comment } from '@crowi/api-contract';

export interface UsePageCommentsResult {
  comments: Comment[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const commentsKey = (pageId: string) => ['comments', { pageId }] as const;

/**
 * Fetch and manage comments for a single page.
 * - The list query is keyed by pageId so it invalidates cleanly after add/delete.
 * - On mutation success we also invalidate the page query so commentCount in the
 *   header refreshes from the server (Comment post-save hook is async).
 */
export function usePageComments(pageId: string | null | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: commentsKey(pageId ?? ''),
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

  const invalidate = () => {
    if (!pageId) return;
    queryClient.invalidateQueries({ queryKey: commentsKey(pageId) });
    // commentCount on the page header is driven by the page query.
    queryClient.invalidateQueries({ queryKey: ['page'] });
  };

  const addMutation = useMutation({
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
      const message =
        result.status === 400 || result.status === 404 || result.status === 403
          ? result.body.error.message
          : 'Failed to add comment';
      throw new Error(message);
    },
    onSuccess: () => invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (commentId: string) => {
      if (!pageId) throw new Error('pageId is required');
      const result = await apiClient.comment.deleteComment({
        body: { comment_id: commentId, page_id: pageId },
      });
      if (result.status === 200) {
        return true;
      }
      const message =
        result.status === 400 || result.status === 404 || result.status === 403
          ? result.body.error.message
          : 'Failed to delete comment';
      throw new Error(message);
    },
    onSuccess: () => invalidate(),
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
    addComment: addMutation.mutateAsync,
    isAdding: addMutation.isPending,
    addError: addMutation.error as Error | null,
    deleteComment: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    deleteError: deleteMutation.error as Error | null,
  };
}
