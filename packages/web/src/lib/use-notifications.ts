'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Notification } from '@crowi/api-contract';

/**
 * Query key factory for notification-related queries.
 * - ['notifications', 'status']: unread count for the current user
 * - ['notifications', 'list', { limit, offset }]: paginated notification list
 *
 * RFC-0006 Phase 4 Batch 3 — switched from `apiClient.notification.*`
 * (ts-rest) to `apiClient.notifications.*.$method` (`createClient`).
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

const EMPTY_LIST = {
  notifications: [] as Notification[],
  pager: { prev: null, next: null, offset: 0 },
};

/**
 * Default react-query options shared by all notification REST hooks.
 * Notifications can fall back to a pure-REST baseline (when the
 * `/notifications/<userId>` WebSocket never connects or stays down),
 * so we deliberately opt-in to the two event-driven refetch triggers
 * that the QueryClient default disables:
 *
 *   - `refetchOnWindowFocus` — the user returning to the tab is a
 *     strong "now please be fresh" signal and refetches only when the
 *     data is `stale` (so a focus while a query is still fresh is a
 *     cheap no-op).
 *   - `refetchOnReconnect` — same idea for `online` after a network
 *     blip. Without this, a tab that lost the WebSocket mid-blip
 *     would never refresh its bell.
 *
 * `staleTime` is intentionally short (30s) so focus / reconnect
 * actually fire a refetch — the QueryClient default `staleTime: 0`
 * already triggers them, but a small window matches the cadence the
 * old 30s polling loop used to give the UI and rules out flap.
 *
 * This is NOT a return of the 30s polling loop: `refetchInterval` is
 * still unset, so a backgrounded / focused-but-idle tab makes zero
 * requests.
 */
const NOTIFICATION_QUERY_DEFAULTS = {
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

/**
 * Hook to fetch the unread notification count for the current user.
 *
 * Polling was removed in favour of a `/notifications/<userId>`
 * WebSocket invalidation channel — `useNotificationsSocket()`,
 * mounted once in `(auth)/layout.tsx`, listens for server-pushed
 * `changed` ticks and invalidates `notificationKeys.all`, which
 * re-runs this query through the normal react-query refetch path.
 * When the WebSocket never connects (handler not deployed, network)
 * the bell falls back to focus/reconnect-driven refetches — see
 * `NOTIFICATION_QUERY_DEFAULTS` — so a backgrounded tab with a dead
 * socket isn't stuck on a stale count forever.
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.status(),
    queryFn: async () => {
      const response = await apiClient.notifications.status.$get();
      if (response.status === 401) return 0;
      if (!response.ok) throw new Error('Failed to fetch unread notification count');
      const body = await response.json();
      return body.count;
    },
    ...NOTIFICATION_QUERY_DEFAULTS,
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
      const response = await apiClient.notifications.$get({
        query: { limit: String(limit), offset: String(offset) },
      });
      if (response.status === 401) return EMPTY_LIST;
      if (!response.ok) throw new Error('Failed to fetch notifications');
      return await response.json();
    },
    enabled,
    ...NOTIFICATION_QUERY_DEFAULTS,
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
      const response = await apiClient.notifications.$get({
        query: { limit: String(limit), offset: String(pageParam) },
      });
      if (response.status === 401) throw new Error('Authentication required');
      if (!response.ok) throw new Error('Failed to fetch notifications');
      return await response.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.pager.next !== null) {
        return lastPage.pager.next;
      }
      return undefined;
    },
    ...NOTIFICATION_QUERY_DEFAULTS,
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
      const response = await apiClient.notifications.read.$post({ json: {} });
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
      const response = await apiClient.notifications[':id'].open.$post({
        param: { id: notificationId },
      });
      if (response.status === 401) throw new Error('Authentication required');
      if (response.status === 404) throw new Error('Failed to open notification');
      if (!response.ok) throw new Error('Failed to open notification');
      const body = await response.json();
      return body.notification;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
