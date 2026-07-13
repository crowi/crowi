'use client';

import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import type { PaginationRequest } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';
import { userPageKeys } from './page-query-keys';

/**
 * RFC-0006 Phase 4 Batch 2 — migrated from `apiClient.user.*` (ts-rest)
 * to `apiClientV2.user[':username'].$get` (`createClient`). The path-param
 * + pagination query shape is unchanged; the only call-site difference
 * is `response.ok` / `response.json()` vs ts-rest's `result.status`
 * narrowing. Both 401 and 404 surface a structured error envelope
 * (`{ error: { code, message } }`) — the hook extracts the wire
 * message when present so callers see "Authentication required" /
 * "User not found" naturally.
 */
const userNotFound = async (response: Response): Promise<never> => {
  if (response.status === 401) throw new Error('Authentication required');
  if (response.status === 404) throw new Error('User not found');
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message || 'Failed to fetch user');
  } catch {
    throw new Error('Failed to fetch user');
  }
};

/**
 * Hook to fetch user page data (profile with statistics)
 */
export function useUserPage(username: string) {
  return useQuery({
    queryKey: userPageKeys.profile(username),
    queryFn: async () => {
      const response = await apiClientV2.user[':username'].$get({ param: { username } });
      if (response.ok) {
        return response.json();
      }
      return userNotFound(response);
    },
    enabled: !!username,
    // A missing / forbidden user is a definite answer — don't retry it
    // (otherwise every `@mention` of a non-user and every bad /user/<x>
    // URL spins through the default 3 retries before settling).
    retry: (failureCount, error) => {
      const message = error instanceof Error ? error.message : '';
      if (message === 'User not found' || message === 'Authentication required') return false;
      return failureCount < 2;
    },
  });
}

/**
 * Hook to fetch user bookmarks with pagination
 */
export function useUserBookmarks(username: string, params: PaginationRequest = { limit: 10, offset: 0 }) {
  return useQuery({
    queryKey: userPageKeys.bookmarksDetail(username, params),
    queryFn: async () => {
      const response = await apiClientV2.user[':username'].bookmarks.$get({
        param: { username },
        query: { limit: String(params.limit), offset: String(params.offset) },
      });
      if (response.ok) {
        return response.json();
      }
      return userNotFound(response);
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user created pages with pagination
 */
export function useUserPages(username: string, params: PaginationRequest = { limit: 10, offset: 0 }) {
  return useQuery({
    queryKey: userPageKeys.pagesDetail(username, params),
    queryFn: async () => {
      const response = await apiClientV2.user[':username'].pages.$get({
        param: { username },
        query: { limit: String(params.limit), offset: String(params.offset) },
      });
      if (response.ok) {
        return response.json();
      }
      return userNotFound(response);
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user bookmarks with infinite scrolling
 */
export function useUserBookmarksInfinite(username: string, limit: number = 10) {
  return useInfiniteQuery({
    queryKey: userPageKeys.bookmarksInfinite(username, limit),
    queryFn: async ({ pageParam = 0 }) => {
      const response = await apiClientV2.user[':username'].bookmarks.$get({
        param: { username },
        query: { limit: String(limit), offset: String(pageParam) },
      });
      if (response.ok) {
        return response.json();
      }
      return userNotFound(response);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.pager.next !== null) {
        return lastPage.pager.next;
      }
      return undefined;
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user pages with infinite scrolling
 */
export function useUserPagesInfinite(username: string, limit: number = 10) {
  return useInfiniteQuery({
    queryKey: userPageKeys.pagesInfinite(username, limit),
    queryFn: async ({ pageParam = 0 }) => {
      const response = await apiClientV2.user[':username'].pages.$get({
        param: { username },
        query: { limit: String(limit), offset: String(pageParam) },
      });
      if (response.ok) {
        return response.json();
      }
      return userNotFound(response);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.pager.next !== null) {
        return lastPage.pager.next;
      }
      return undefined;
    },
    enabled: !!username,
  });
}
