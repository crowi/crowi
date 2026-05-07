'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';

/**
 * Query key factory for watch (notification subscription) queries.
 * - ['watch', pageId]: watch status of a single page for the current user
 *
 * The watch state is intentionally kept on its own key (not piggy-backed on
 * the `page` query) because `watching` is not part of the page document and
 * is derived from a separate Watcher collection + getNotificationTargetUsers
 * fallback. Toggling watch should NOT invalidate the page document cache.
 */
export const watchKeys = {
  all: ['watch'] as const,
  detail: (pageId: string) => ['watch', pageId] as const,
};

/**
 * Fetch the current user's watch status for a page. Returns
 * `watching: boolean | undefined` while loading.
 *
 * Auth errors are mapped to `watching=false` (silent) rather than thrown so
 * the page header does not surface a noisy error for an auxiliary control.
 */
export function useWatchStatus(pageId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: pageId ? watchKeys.detail(pageId) : watchKeys.all,
    queryFn: async (): Promise<{ watching: boolean }> => {
      if (!pageId) return { watching: false };
      const result = await apiClient.page.getWatchStatus({
        query: { page_id: pageId },
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        // Not authenticated — surface as not watching (button hidden by caller anyway).
        return { watching: false };
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message);
      }
      if (result.status === 404) {
        throw new Error('Page not found');
      }
      throw new Error('Failed to fetch watch status');
    },
    enabled: !!pageId && options?.enabled !== false,
  });
}

/**
 * Toggle the current user's watch status for a page.
 *
 * Unlike `useToggleBookmark`, callers must pass the current `watching` value
 * so the hook knows which state to send. On success the watch query is
 * updated in place via `setQueryData` to avoid a follow-up refetch.
 */
export function useToggleWatch(pageId: string | undefined, watching: boolean) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (): Promise<{ watching: boolean }> => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      const next = !watching;
      const result = await apiClient.page.setWatchStatus({
        body: { page_id: pageId, watching: next },
      });
      if (result.status === 200) {
        return result.body;
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
      throw new Error('Failed to update watch status');
    },
    onSuccess: (data) => {
      if (!pageId) return;
      queryClient.setQueryData<{ watching: boolean }>(watchKeys.detail(pageId), data);
    },
  });

  return {
    watching,
    toggle: mutation.mutate,
    toggleAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}
