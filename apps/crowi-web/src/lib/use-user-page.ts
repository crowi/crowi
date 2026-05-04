'use client';

import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { PaginationRequest } from '@crowi/api-contract';

/**
 * Hook to fetch user page data (profile with statistics)
 */
export function useUserPage(username: string) {
  return useQuery({
    queryKey: ['user', username],
    queryFn: async () => {
      const result = await apiClient.user.getUserPage({ params: { username } });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('User not found');
      }
      throw new Error('Failed to fetch user page');
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user bookmarks with pagination
 */
export function useUserBookmarks(username: string, params: PaginationRequest = { limit: 10, offset: 0 }) {
  return useQuery({
    queryKey: ['user', username, 'bookmarks', params],
    queryFn: async () => {
      const result = await apiClient.user.getUserBookmarks({
        params: { username },
        query: params,
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('User not found');
      }
      throw new Error('Failed to fetch bookmarks');
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user created pages with pagination
 */
export function useUserPages(username: string, params: PaginationRequest = { limit: 10, offset: 0 }) {
  return useQuery({
    queryKey: ['user', username, 'pages', params],
    queryFn: async () => {
      const result = await apiClient.user.getUserPages({
        params: { username },
        query: params,
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('User not found');
      }
      throw new Error('Failed to fetch pages');
    },
    enabled: !!username,
  });
}

/**
 * Hook to fetch user bookmarks with infinite scrolling
 */
export function useUserBookmarksInfinite(username: string, limit: number = 10) {
  return useInfiniteQuery({
    queryKey: ['user', username, 'bookmarks', 'infinite', limit],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await apiClient.user.getUserBookmarks({
        params: { username },
        query: { limit, offset: pageParam },
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('User not found');
      }
      throw new Error('Failed to fetch bookmarks');
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
    queryKey: ['user', username, 'pages', 'infinite', limit],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await apiClient.user.getUserPages({
        params: { username },
        query: { limit, offset: pageParam },
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401) {
        throw new Error('Authentication required');
      }
      if (result.status === 404) {
        throw new Error('User not found');
      }
      throw new Error('Failed to fetch pages');
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
