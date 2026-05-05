'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Bookmark } from '@crowi/api-contract';

/**
 * Query key factory for bookmark-related queries.
 * - ['bookmark', pageId]: bookmark status of a single page for the current user
 * - ['user', username, 'bookmarks']: bookmark list on /user/:username/bookmarks
 *   (uses prefix matching via invalidateQueries)
 */
export const bookmarkKeys = {
  all: ['bookmark'] as const,
  detail: (pageId: string) => ['bookmark', pageId] as const,
};

/**
 * Hook to fetch the current user's bookmark for a specific page.
 * Returns `bookmark: Bookmark | null`. `null` means the page is not bookmarked.
 */
export function useBookmark(pageId: string | undefined) {
  return useQuery({
    queryKey: pageId ? bookmarkKeys.detail(pageId) : bookmarkKeys.all,
    queryFn: async (): Promise<Bookmark | null> => {
      if (!pageId) return null;
      const result = await apiClient.bookmark.getBookmark({
        query: { page_id: pageId },
      });
      if (result.status === 200) {
        return result.body.bookmark;
      }
      if (result.status === 401) {
        // Not authenticated — treat as not bookmarked, do not throw to avoid noisy errors
        return null;
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to fetch bookmark');
    },
    enabled: !!pageId,
  });
}

/**
 * Hook to toggle a bookmark for a specific page.
 * - If currently bookmarked, calls DELETE /bookmarks
 * - If not bookmarked, calls POST /bookmarks
 *
 * On success, invalidates:
 * - ['bookmark', pageId] for this page
 * - ['user'] (prefix) so /user/:username/bookmarks pages refetch
 */
export function useToggleBookmark(pageId: string | undefined) {
  const queryClient = useQueryClient();
  const { data: bookmark } = useBookmark(pageId);
  const isBookmarked = bookmark !== null && bookmark !== undefined;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      if (isBookmarked) {
        const result = await apiClient.bookmark.removeBookmark({
          body: { page_id: pageId },
        });
        if (result.status === 200) {
          return { bookmark: null as Bookmark | null };
        }
        if (result.status === 400) {
          throw new Error(result.body.error.message);
        }
        if (result.status === 401) {
          throw new Error('Authentication required');
        }
        throw new Error('Failed to remove bookmark');
      }

      const result = await apiClient.bookmark.addBookmark({
        body: { page_id: pageId },
      });
      if (result.status === 200) {
        return { bookmark: result.body.bookmark };
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message);
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      throw new Error('Failed to add bookmark');
    },
    onSuccess: () => {
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: bookmarkKeys.detail(pageId) });
      }
      // Invalidate any user bookmark lists (e.g. /user/:username/bookmarks)
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });

  return {
    bookmark: bookmark ?? null,
    isBookmarked,
    toggle: mutation.mutate,
    toggleAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}
