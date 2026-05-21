'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { SeenUsersResponse } from '@crowi/api-contract';

/**
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.{getSeenUsers,seenPage}`
 * (ts-rest) to `apiClientV2.pages['seen-users'].$get` and
 * `apiClientV2.pages.seen.$post` (hc<AppType>). Wire payload is unchanged.
 */
export const seenKeys = {
  all: ['seen-users'] as const,
  // `limit` is part of the key so preview (capped) and full-list caches stay
  // independent. Pass `undefined` for the full list.
  detail: (pageId: string, limit?: number) => ['seen-users', pageId, { limit }] as const,
  // Prefix used by invalidate calls to drop every variant of `pageId` at once.
  pagePrefix: (pageId: string) => ['seen-users', pageId] as const,
};

const EMPTY_RESULT: SeenUsersResponse = { seenUsers: [], seenUsersCount: 0 };

/**
 * Fetch the seen-users list for a page. Errors fall back to empty — this is
 * auxiliary UI and shouldn't break the page view.
 *
 * `limit` caps the avatar list (server-side); `seenUsersCount` always
 * reflects the full count.
 */
export function useSeenUsers(pageId: string | undefined, options?: { enabled?: boolean; limit?: number }) {
  const limit = options?.limit;
  return useQuery({
    queryKey: pageId ? seenKeys.detail(pageId, limit) : seenKeys.all,
    queryFn: async (): Promise<SeenUsersResponse> => {
      if (!pageId) return EMPTY_RESULT;
      const response = await apiClientV2.pages['seen-users'].$get({
        query: {
          page_id: pageId,
          limit: limit !== undefined ? String(limit) : undefined,
        },
      });
      if (!response.ok) return EMPTY_RESULT;
      return await response.json();
    },
    enabled: !!pageId && options?.enabled !== false,
  });
}

/**
 * Mark a page as seen by the current user. Best-effort: errors are silenced
 * and every seen-users cache for the page is invalidated so both preview and
 * full-list subscribers refetch.
 */
export function useMarkSeen(pageId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<SeenUsersResponse | null> => {
      if (!pageId) return null;
      const response = await apiClientV2.pages.seen.$post({ json: { page_id: pageId } });
      if (!response.ok) return null;
      return await response.json();
    },
    onSuccess: (data) => {
      if (!data || !pageId) return;
      queryClient.invalidateQueries({ queryKey: seenKeys.pagePrefix(pageId) });
    },
  });
}

/**
 * Fire `useMarkSeen` exactly once per `pageId` when `enabled` is true.
 * Guards React 19 StrictMode double-invocation; useMutation does not auto-dedupe by arg.
 */
export function useMarkSeenOnView(pageId: string | undefined, enabled: boolean) {
  const { mutate } = useMarkSeen(pageId);
  const firedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !pageId) return;
    if (firedForRef.current === pageId) return;
    firedForRef.current = pageId;
    mutate();
  }, [pageId, enabled, mutate]);
}
