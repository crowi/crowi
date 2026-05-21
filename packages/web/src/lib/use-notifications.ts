'use client';

// TS2589-RFC-0006-PHASE-6: the `apiClientV2` proxy is typed as `any`
// because `hc<AppType>` hits TS2589 (instantiation depth) at 90+ routes.
// Each `response.json() as <Schema>` cast below preserves the
// caller-side `.map(...)` / property-access type inference and is
// expected to drop back to inferred types in Phase 6 once `client.ts`
// splits the contract chain.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { ListNotificationsResponse, Notification, OpenNotificationResponse } from '@crowi/api-contract';

/**
 * Query key factory for notification-related queries.
 * - ['notifications', 'status']: unread count for the current user
 * - ['notifications', 'list', { limit, offset }]: paginated notification list
 *
 * RFC-0006 Phase 4 Batch 3 — switched from `apiClient.notification.*`
 * (ts-rest) to `apiClientV2.notifications.*.$method` (hc<AppType>).
 * Wire payload is unchanged. 401 silently degrades to a zero-state so
 * signed-out pages don't surface noisy auth errors (matches the legacy
 * `unwrapResult` silent option).
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

const EMPTY_LIST = {
  notifications: [] as Notification[],
  pager: { prev: null, next: null, offset: 0 },
};

/**
 * Hook to fetch the unread notification count for the current user.
 * Polls every 30s while the tab is active.
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.status(),
    queryFn: async () => {
      const response = await apiClientV2.notifications.status.$get();
      if (response.status === 401) return 0;
      if (!response.ok) throw new Error('Failed to fetch unread notification count');
      const body = (await response.json()) as { count: number };
      return body.count;
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
    queryFn: async () => {
      const response = await apiClientV2.notifications.$get({
        query: { limit: String(limit), offset: String(offset) },
      });
      if (response.status === 401) return EMPTY_LIST;
      if (!response.ok) throw new Error('Failed to fetch notifications');
      return (await response.json()) as ListNotificationsResponse;
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
      const response = await apiClientV2.notifications.$get({
        query: { limit: String(limit), offset: String(pageParam) },
      });
      if (response.status === 401) throw new Error('Authentication required');
      if (!response.ok) throw new Error('Failed to fetch notifications');
      return (await response.json()) as ListNotificationsResponse;
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
      const response = await apiClientV2.notifications.read.$post({ json: {} });
      if (response.status === 401) throw new Error('Authentication required');
      if (!response.ok) throw new Error('Failed to mark notifications as read');
      return true;
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
      const response = await apiClientV2.notifications[':id'].open.$post({
        param: { id: notificationId },
        json: {},
      });
      if (response.status === 401) throw new Error('Authentication required');
      if (response.status === 404) throw new Error('Failed to open notification');
      if (!response.ok) throw new Error('Failed to open notification');
      const body = (await response.json()) as OpenNotificationResponse;
      return body.notification;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
