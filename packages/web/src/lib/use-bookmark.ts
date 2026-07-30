'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { userPageKeys } from './page-query-keys';
import type { Bookmark } from '@crowi/api-contract';

/**
 * Query key factory for bookmark-related queries.
 * - ['bookmark', pageId]: bookmark status of a single page for the current user
 * - ['user', username, 'bookmarks']: bookmark list on /user/:username/bookmarks
 *   (uses prefix matching via invalidateQueries)
 *
 * RFC-0006 Phase 4 Batch 3 — switched from `apiClient.bookmark.*` (ts-rest)
 * to `apiClient.bookmarks.*.$method` (`createClient`). Wire payload is
 * unchanged; the only call-site difference is `response.ok` /
 * `response.json()` instead of ts-rest's `result.status` + `result.body`.
 * Errors come back with the same `{ error: { code, message } }` envelope
 * — the hooks fall back to a generic "Failed to ..." for non-401 / non-
 * actionable cases, mirroring the legacy `unwrapResult` calls.
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
    queryFn: async () => {
      if (!pageId) return null as Bookmark | null;
      const response = await apiClient.bookmarks.$get({ query: { page_id: pageId } });
      // 401 — treat as not bookmarked rather than throwing, to keep
      // page rendering quiet for signed-out users.
      if (response.status === 401) return null as Bookmark | null;
      if (response.ok) {
        const body = await response.json();
        return body.bookmark as Bookmark | null;
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
    mutationFn: async (): Promise<{ bookmark: Bookmark | null }> => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      if (isBookmarked) {
        const response = await apiClient.bookmarks.$delete({ json: { page_id: pageId } });
        if (response.status === 401) throw new Error('Authentication required');
        if (response.ok) return { bookmark: null };
        throw new Error('Failed to remove bookmark');
      }

      const response = await apiClient.bookmarks.$post({ json: { page_id: pageId } });
      if (response.status === 401) throw new Error('Authentication required');
      if (response.ok) {
        const body = await response.json();
        return { bookmark: body.bookmark };
      }
      throw new Error('Failed to add bookmark');
    },
    onSuccess: () => {
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: bookmarkKeys.detail(pageId) });
      }
      // Invalidate user bookmark lists only (`userPageKeys.bookmarks*`).
      // `['user']` alone would also refetch unrelated user/* queries
      // (profile / pages / etc.) on every bookmark toggle.
      queryClient.invalidateQueries({
        predicate: (query) => userPageKeys.isBookmarksQuery(query.queryKey),
      });
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
