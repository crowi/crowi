'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { LikersResponse } from '@crowi/api-contract';

/**
 * RFC-0005 Phase 3 — query-key factory for the page "liked by" list.
 * Mirrors `seenKeys` (`use-seen.ts`): `limit` is part of the detail key
 * so a capped preview and the full list keep independent caches.
 */
export const likersKeys = {
  all: ['likers'] as const,
  detail: (pageId: string, limit?: number) => ['likers', pageId, { limit }] as const,
  pagePrefix: (pageId: string) => ['likers', pageId] as const,
};

const EMPTY_RESULT: LikersResponse = { users: [], totalCount: 0 };

/**
 * Fetch the liker list for a page. Errors fall back to empty — this is
 * auxiliary modal UI and shouldn't break the page view.
 *
 * `limit` caps the returned `users` (server-side); `totalCount` always
 * reflects the full count.
 */
export function useLikers(pageId: string | undefined, options?: { enabled?: boolean; limit?: number }) {
  const limit = options?.limit;
  return useQuery({
    queryKey: pageId ? likersKeys.detail(pageId, limit) : likersKeys.all,
    queryFn: async (): Promise<LikersResponse> => {
      if (!pageId) return EMPTY_RESULT;
      const response = await apiClient.pages[':id'].likers.$get({
        param: { id: pageId },
        query: limit !== undefined ? { limit: String(limit) } : {},
      });
      if (!response.ok) return EMPTY_RESULT;
      return response.json();
    },
    enabled: !!pageId && options?.enabled !== false,
  });
}
