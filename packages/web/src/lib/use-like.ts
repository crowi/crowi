'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PageWithRevision } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { likersKeys } from './use-likers';
import { notify } from './notify';
import { m } from '@paraglide/messages.js';

/**
 * Query key prefix for like-related caches. We do not cache "is liked" by
 * itself: like state is derived from `page.liker` returned by getPage. After
 * a successful toggle we invalidate the `page` query so the header refetches
 * with the updated liker / likerCount.
 *
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.{like,unlike}Page`
 * (ts-rest) to `apiClient.pages.{like,unlike}.$post` (`createClient`).
 */
export const likeKeys = {
  all: ['like'] as const,
};

/** Cached shape of a `['page', ...]` query (see `usePage`). */
interface CachedPageData {
  page: PageWithRevision | null;
  notFound: boolean;
  notGranted: boolean;
}

/**
 * RFC-0005 Phase 3 — optimistically patch every cached `['page']` entry
 * whose page matches `pageId`, flipping `liker` / `likerCount` so the
 * meta-chip count updates the instant the like button is pressed. The
 * page query key embeds `{path, revision_id}` (not the bare id), so we
 * scan all `['page']` caches rather than addressing one key.
 *
 * Returns the list of `[queryKey, previousData]` pairs so `onError` can
 * roll the caches back if the request fails.
 */
function patchCachedPages(queryClient: ReturnType<typeof useQueryClient>, pageId: string, nextIsLiked: boolean) {
  const snapshots: Array<[readonly unknown[], CachedPageData]> = [];

  for (const [queryKey, data] of queryClient.getQueriesData<CachedPageData>({ queryKey: ['page'] })) {
    if (!data?.page || data.page._id !== pageId) continue;
    snapshots.push([queryKey, data]);

    const liker = data.page.liker ?? [];
    const currentCount = data.page.likerCount ?? liker.length;
    queryClient.setQueryData<CachedPageData>(queryKey, {
      ...data,
      page: {
        ...data.page,
        likerCount: Math.max(0, currentCount + (nextIsLiked ? 1 : -1)),
      },
    });
  }

  return snapshots;
}

/**
 * Hook to toggle the current user's like on a specific page.
 *
 * Unlike `useToggleBookmark`, this hook does not own the source-of-truth for
 * "is liked" — that is derived from `page.liker` (returned by `getPage`).
 * Callers must pass `isLiked` so the hook knows which endpoint to call.
 *
 * The like meta-chip count is updated optimistically (`onMutate`) and rolled
 * back with an error toast (`onError`) if the request fails. On success the
 * `page` query is invalidated so liker / likerCount reconcile with the server.
 */
export function useToggleLike(pageId: string | undefined, isLiked: boolean) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      const response = isLiked
        ? await apiClient.pages.unlike.$post({ json: { page_id: pageId } })
        : await apiClient.pages.like.$post({ json: { page_id: pageId } });

      if (response.status === 401) throw new Error('Authentication required');
      if (response.ok) {
        const data = await response.json();
        return { page: data.page };
      }
      throw new Error(isLiked ? 'Failed to unlike page' : 'Failed to like page');
    },
    onMutate: () => {
      if (!pageId) return { snapshots: [] };
      // `isLiked` is the state *before* the toggle, so the next state is `!isLiked`.
      const snapshots = patchCachedPages(queryClient, pageId, !isLiked);
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      // Roll the optimistic count back, then surface the failure.
      for (const [queryKey, previous] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, previous);
      }
      notify.error(isLiked ? m['page.unlike_failed']() : m['page.like_failed']());
    },
    onSettled: () => {
      // Reconcile with the server (liker / likerCount) regardless of
      // outcome. Scope the invalidation to caches whose page matches
      // `pageId`: the page query key embeds {path, revision_id} rather
      // than the bare id, so we filter by payload like `patchCachedPages`
      // — a bare `['page']` invalidation would refetch every cached page.
      queryClient.invalidateQueries({
        queryKey: ['page'],
        predicate: (query) => (query.state.data as CachedPageData | undefined)?.page?._id === pageId,
      });
      if (pageId) {
        queryClient.invalidateQueries({ queryKey: likersKeys.pagePrefix(pageId) });
      }
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
