'use client';

import type { PageHistoryEntry, PageHistoryTracking } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { useInfiniteQuery } from '@tanstack/react-query';

import { apiClient } from './api-client';
import { pageHistoryKeys } from './page-query-keys';

/**
 * RFC-0021 Phase 3 — a page's content revisions and metadata events as one
 * timeline.
 *
 * Flattening lives here rather than at the call sites: the pagination is an
 * implementation detail of this hook, and a component that reaches into
 * `data.pages` ends up re-deriving the order the server already decided.
 */
export interface UsePageHistoryResult {
  entries: PageHistoryEntry[];
  tracking: PageHistoryTracking | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

export function usePageHistory(pageId: string | null | undefined): UsePageHistoryResult {
  const query = useInfiniteQuery({
    queryKey: pageHistoryKeys.timeline(pageId ?? ''),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (!pageId) return { entries: [] as PageHistoryEntry[], nextCursor: null, tracking: null as PageHistoryTracking | null };
      const response = await apiClient.pages[':pageId'].history.$get({
        param: { pageId },
        query: pageParam == null ? {} : { cursor: pageParam },
      });
      if (!response.ok) throw new Error(m['page_history.history_fetch_failed']());
      const body = await response.json();
      return { entries: body.entries as PageHistoryEntry[], nextCursor: body.nextCursor, tracking: body.tracking as PageHistoryTracking };
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(pageId),
  });

  return {
    entries: query.data?.pages.flatMap((page) => page.entries) ?? [],
    tracking: query.data?.pages[0]?.tracking ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error) ?? null,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
  };
}
