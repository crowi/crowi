'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';

/**
 * Query key factory for watch (notification subscription) queries.
 *
 * Watch state is kept on its own key (not piggy-backed on the page query)
 * because `watching` is not part of the page document and is derived from a
 * separate Watcher collection + getNotificationTargetUsers fallback.
 * Toggling watch should NOT invalidate the page document cache.
 */
export const watchKeys = {
  all: ['watch'] as const,
  detail: (pageId: string) => ['watch', pageId] as const,
};

// The /pages/watch fallback path runs two distinct() queries on Comment and
// Revision when no Watcher row exists. Hold the result in cache long enough
// to survive header rerenders / window focus without re-hitting the API.
const WATCH_STALE_TIME = 5 * 60 * 1000;

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
    staleTime: WATCH_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

/**
 * Toggle the current user's watch status for a page. Mirrors `useToggleBookmark`:
 * the hook reads the current `watching` from the cache via `useWatchStatus`,
 * so callers don't need to thread it through.
 */
export function useToggleWatch(pageId: string | undefined) {
  const queryClient = useQueryClient();
  const { data } = useWatchStatus(pageId);
  const watching = data?.watching ?? false;

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
    onSuccess: (next) => {
      if (!pageId) return;
      queryClient.setQueryData<{ watching: boolean }>(watchKeys.detail(pageId), next);
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
