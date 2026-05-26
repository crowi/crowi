'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NotificationsServerMessageSchema, type NotificationsTokenResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';
import { notificationKeys } from './use-notifications';

/**
 * Realtime invalidation WebSocket client for `/notifications/<userId>`.
 *
 * The NotificationBell used to poll `GET /notifications/status` every
 * 30s — 2 requests per minute per signed-in user, 33 RPS baseline at
 * 1k concurrent tabs. This hook replaces that polling loop with a
 * server-pushed `{type:'changed'}` invalidation tick. The hook itself
 * does NOT fetch notification data — it only flips
 * `notificationKeys.all` to "stale" and lets the existing REST
 * queries (`useUnreadCount`, `useNotifications*`) refetch.
 *
 * Lifecycle:
 *   1. fetch a short-lived JWT (`GET /notifications/token`) once.
 *      The token is a handshake-only credential — the server does NOT
 *      re-verify it after upgrade, mirroring presence / collab — so we
 *      never refetch on a schedule. A fresh token is only needed when
 *      the existing socket dies and we have to handshake again.
 *   2. open `wss://<host>/notifications/<userId>?token=<token>` and
 *      hold the socket open indefinitely
 *   3. on `changed`, debounce 200ms and invalidate
 *      `notificationKeys.all` so every notification query refetches
 *   4. on (re)connect open, fire a one-shot invalidate to catch up
 *      any change that landed while we were disconnected
 *   5. on unclean close, exponential backoff reconnect (1s → 15s);
 *      4401 (expired token) reactively invalidates the
 *      `notificationsToken` query so the next refetch yields a fresh
 *      token + a new effect run + a new handshake; 4403 (forbidden) is
 *      a bug-shaped state and we just stop
 *
 * Failure is non-fatal: when the WebSocket never connects (handler
 * not deployed, network) the hook stays silent and the UI keeps
 * working — user actions still trigger react-query refetches via the
 * normal staleTime path, so the worst case is "no realtime push,
 * everything else fine". This mirrors `use-presence`'s degrade
 * contract.
 *
 * Mount once per (auth) tab — the NotificationBell is a child of the
 * `(auth)/layout.tsx` shell so a single hook call there gives every
 * authed page the realtime push without per-page wiring.
 */

/** WebSocket reconnect backoff after an unclean close, capped. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Client-side debounce window for batching `changed` ticks. A
 * mention-everyone publish can produce a burst of ticks for one
 * recipient (one per activity row); collapsing them to one
 * `invalidateQueries` call keeps the bell from N-rendering in
 * quick succession.
 */
const INVALIDATE_DEBOUNCE_MS = 200;

/**
 * Close code for an invalid / expired notifications token (the
 * notifications attach handler's `WS_CLOSE.INVALID_TOKEN`). The token
 * in hand is stale, so an immediate retry with the same token loops —
 * reactively invalidate the `notificationsToken` query to force a
 * fresh refetch, which re-runs the effect with the new token.
 */
const NOTIFICATIONS_CLOSE_INVALID_TOKEN = 4401;
/**
 * Close code for a token whose `selfUserId` did not match the URL
 * path. In practice this only fires on a bug-shaped request (we
 * always sign with the authed user id), but stop reconnecting all the
 * same — looping would just churn the server.
 */
const NOTIFICATIONS_CLOSE_FORBIDDEN = 4403;

/**
 * Resolve the `/notifications` WebSocket base URL. Mirrors
 * `use-presence`'s `resolvePresenceUrl` exactly — same env precedence
 * (`NEXT_PUBLIC_COLLAB_URL` wins, else derive from
 * `NEXT_PUBLIC_API_URL`) because all three WebSocket namespaces
 * (`/collab`, `/presence`, `/notifications`) attach to the same api
 * `http.Server`. We deliberately do NOT use `window.location` — the
 * Next.js dev split's HTTP rewrites silently drop WebSocket upgrade
 * events.
 */
function resolveNotificationsUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_URL;
  const base = fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/collab$/, '') : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4301';
  return `${base.replace(/^http/, 'ws')}/notifications`;
}

/**
 * Fetch the short-lived notifications token. The token is only used
 * during the WebSocket handshake — once upgraded, the server does not
 * re-verify it (same contract as presence / collab). So we deliberately
 * do NOT set `refetchInterval`: a proactive periodic refetch would flip
 * the `token` dep on the consuming effect, tear the socket down, and
 * re-handshake on every cycle. That cycle also triggers the `onopen`
 * catch-up invalidate, which would in turn fire
 * `notifications.status.$get` on the same cadence — effectively
 * restoring the 30s polling we just removed.
 *
 * Instead we mint the token once and rely on a reactive refetch: when
 * the WebSocket closes with 4401 (stale / expired token), the
 * connection effect invalidates this query, which causes a refetch,
 * which yields a new token + a new effect run + a new handshake.
 *
 * Disabled until `enabled` is true so the (public) login screen
 * doesn't blast `/notifications/token` requests at an unauthed
 * server.
 */
function useNotificationsToken(enabled: boolean) {
  return useQuery({
    queryKey: ['notificationsToken'],
    queryFn: async (): Promise<NotificationsTokenResponse> => {
      const response = await apiClientV2.notifications.token.$get();
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error
            ? String(body.error.message)
            : 'Failed to issue notifications token';
        throw new Error(message);
      }
      return response.json();
    },
    enabled,
    refetchOnWindowFocus: false,
    // Notifications realtime is auxiliary — one failed token request
    // just keeps the bell on its REST baseline, no need to hammer.
    retry: 1,
  });
}

export interface UseNotificationsSocketOptions {
  /**
   * Pass `false` to keep the hook idle (e.g. before auth has resolved).
   * Defaults to `true` so the typical call site —
   * `useNotificationsSocket()` in `(auth)/layout.tsx` — just works
   * once the layout mounts.
   */
  enabled?: boolean;
}

/**
 * Drive the `/notifications/<userId>` WebSocket. Returns nothing — the
 * effect is to invalidate `notificationKeys.all` on every server-push
 * tick (and on reconnect). Consumers read notification state through
 * the existing `useUnreadCount` / `useNotifications*` hooks.
 */
export function useNotificationsSocket(options: UseNotificationsSocketOptions = {}): void {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { data: tokenData, isError: tokenError } = useNotificationsToken(enabled);

  const token = tokenData?.token ?? null;
  const selfUserId = tokenData?.selfUserId ?? null;

  useEffect(() => {
    if (!enabled || !token || !selfUserId || tokenError) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let disposed = false;

    const scheduleInvalidate = () => {
      if (debounceTimer !== null) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (disposed) return;
        // `queryClient` is captured fresh on every effect run; the
        // QueryClientProvider gives us a stable instance so this
        // closure is safe even across reconnects within one mount.
        queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (disposed) return;
      const url = `${resolveNotificationsUrl()}/${encodeURIComponent(selfUserId)}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        // (Re)connect catch-up: fire one invalidate so any change
        // that landed while we were disconnected is picked up.
        // Goes through the debounce window so a fast
        // open→message→open cycle still collapses to one invalidate.
        scheduleInvalidate();
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          // Non-JSON frame — ignore, notifications only speaks JSON.
          return;
        }
        const message = NotificationsServerMessageSchema.safeParse(parsed);
        if (!message.success) return;
        // A parsed server message proves the connection is truly
        // established — the server rejects a bad token *before*
        // sending any frame. Reset the backoff here (rather than on
        // `onopen`, which fires for the doomed handshake too) so a
        // handshake-then-reject loop doesn't pin the reconnect delay
        // at its 1s floor forever. Same pattern as `usePresence`.
        reconnectAttempts = 0;
        scheduleInvalidate();
      };

      ws.onerror = () => {
        // `onclose` always follows `onerror`; handle teardown there.
      };

      ws.onclose = (event) => {
        if (disposed) return;
        // 4401 (stale token): kick the token query to refetch. The new
        // token flips the effect's `token` dep, which re-runs the
        // effect and handshakes anew. We do NOT reconnect inline — the
        // effect re-run is the only path that resolves the stale
        // credential.
        if (event.code === NOTIFICATIONS_CLOSE_INVALID_TOKEN) {
          queryClient.invalidateQueries({ queryKey: ['notificationsToken'] });
          return;
        }
        // 4403 (forbidden): a bug-shaped state (we always sign with the
        // authed user id). Looping would just churn the server, so stop.
        if (event.code === NOTIFICATIONS_CLOSE_FORBIDDEN) return;
        // Otherwise reconnect with capped exponential backoff.
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (socket) {
        // Drop the lifecycle handlers before close so the teardown
        // close doesn't trigger a reconnect.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [enabled, token, selfUserId, tokenError, queryClient]);
}
