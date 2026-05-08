'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { Notification } from '@crowi/api-contract';

/**
 * Query key factory for notification-related queries.
 * - ['notifications', 'status']: unread count for the current user
 * - ['notifications', 'list', { limit, offset }]: paginated notification list
 */
export const notificationKeys = {
  all: ['notifications'] as const,
  status: () => ['notifications', 'status'] as const,
  list: (params: { limit?: number; offset?: number } = {}) => ['notifications', 'list', params] as const,
  infinite: (limit: number) => ['notifications', 'list', 'infinite', limit] as const,
};

/**
 * Polling interval for the unread count (in ms).
 * Refetch is disabled while the tab is inactive to avoid unnecessary traffic.
 */
const UNREAD_COUNT_POLL_INTERVAL_MS = 30_000;

/**
 * Hook to fetch the unread notification count for the current user.
 * Polls every 30s while the tab is active.
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.status(),
    queryFn: async (): Promise<number> => {
      const result = await apiClient.notification.getUnreadCount();
      return unwrapResult(result, {
        ok: (body) => body.count,
        // Not authenticated → treat as zero, do not throw to avoid noisy errors.
        silent: { statuses: [401], value: 0 },
        fallback: 'Failed to fetch unread notification count',
      });
    },
    refetchInterval: UNREAD_COUNT_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export interface UseNotificationsOptions {
  limit?: number;
  offset?: number;
  /**
   * If false, the query is disabled. Defaults to false so callers must opt in
   * (typically when a dropdown is opened) to avoid unnecessary fetches.
   */
  enabled?: boolean;
}

/**
 * Hook to fetch the paginated notification list for the current user.
 *
 * Disabled by default — pass `enabled: true` (e.g. when a dropdown opens)
 * to trigger the query.
 */
export function useNotifications({ limit = 10, offset = 0, enabled = false }: UseNotificationsOptions = {}) {
  return useQuery({
    queryKey: notificationKeys.list({ limit, offset }),
    queryFn: async (): Promise<{ notifications: Notification[]; pager: { prev: number | null; next: number | null; offset: number } }> => {
      const result = await apiClient.notification.listNotifications({
        query: { limit, offset },
      });
      return unwrapResult(result, {
        ok: (body) => ({ notifications: body.notifications, pager: body.pager }),
        silent: { statuses: [401], value: { notifications: [], pager: { prev: null, next: null, offset: 0 } } },
        fallback: 'Failed to fetch notifications',
      });
    },
    enabled,
  });
}

/**
 * Hook to fetch the paginated notification list with infinite scrolling /
 * "load more" semantics. Pages are accumulated as the user requests more.
 *
 * Mirrors the bookmark page pattern (useUserBookmarksInfinite).
 */
export function useNotificationsInfinite(limit: number = 20) {
  return useInfiniteQuery({
    queryKey: notificationKeys.infinite(limit),
    queryFn: async ({ pageParam = 0 }) => {
      const result = await apiClient.notification.listNotifications({
        query: { limit, offset: pageParam },
      });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: { message: 'Authentication required', preferLocal: true } },
        fallback: 'Failed to fetch notifications',
      });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.pager.next !== null) {
        return lastPage.pager.next;
      }
      return undefined;
    },
  });
}

/**
 * Hook to mark all UNREAD notifications of the current user as read (UNOPENED).
 * On success, invalidates both the unread count and the notification list.
 */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = await apiClient.notification.markAllAsRead({ body: {} });
      return unwrapResult(result, {
        ok: () => true,
        errors: { 401: { message: 'Authentication required', preferLocal: true } },
        fallback: 'Failed to mark notifications as read',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/**
 * Hook to open a single notification (transitions its status to OPENED).
 * On success, invalidates both the unread count and the notification list so
 * the badge / dropdown reflect the new status.
 */
export function useOpenNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string): Promise<Notification> => {
      const result = await apiClient.notification.openNotification({
        params: { id: notificationId },
        body: {},
      });
      return unwrapResult(result, {
        ok: (body) => body.notification,
        errors: {
          401: { message: 'Authentication required', preferLocal: true },
          404: 'Failed to open notification',
        },
        fallback: 'Failed to open notification',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
