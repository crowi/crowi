'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';

/**
 * Query key prefix for like-related caches. We do not cache "is liked" by
 * itself: like state is derived from `page.liker` returned by getPage. After
 * a successful toggle we invalidate the `page` query so the header refetches
 * with the updated liker / likerCount.
 */
export const likeKeys = {
  all: ['like'] as const,
};

/**
 * Hook to toggle the current user's like on a specific page.
 *
 * Unlike `useToggleBookmark`, this hook does not own the source-of-truth for
 * "is liked" — that is derived from `page.liker` (returned by `getPage`).
 * Callers must pass `isLiked` so the hook knows which endpoint to call.
 *
 * On success, invalidates:
 * - ['page'] (prefix) so the page header refetches with new liker/likerCount
 */
export function useToggleLike(pageId: string | undefined, isLiked: boolean) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      if (isLiked) {
        const result = await apiClient.page.unlikePage({
          body: { page_id: pageId },
        });
        if (result.status === 200) {
          return { page: result.body.page };
        }
        if (result.status === 400) {
          throw new Error(result.body.error.message);
        }
        if (result.status === 401) {
          throw new Error('Authentication required');
        }
        if (result.status === 404) {
          throw new Error('Page not found');
        }
        throw new Error('Failed to unlike page');
      }

      const result = await apiClient.page.likePage({
        body: { page_id: pageId },
      });
      if (result.status === 200) {
        return { page: result.body.page };
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message);
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('Page not found');
      }
      throw new Error('Failed to like page');
    },
    onSuccess: () => {
      // Invalidate the page query so liker/likerCount refresh in the UI.
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });

  return {
    isLiked,
    toggle: mutation.mutate,
    toggleAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}
