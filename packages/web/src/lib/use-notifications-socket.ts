'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NotificationsServerMessageSchema, type NotificationsTokenResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';
import { resolveWsUrl } from './resolve-ws-url';
import { useAuth } from './use-auth';
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
 *      token + a new effect run + a new handshake; the first 4401 in a
 *      row invalidates immediately (the common case: a genuinely expired
 *      token after a long-open tab), but each further 4401 without an
 *      intervening successful message applies the same capped backoff as
 *      a normal reconnect — defense in depth against a mint/verify secret
 *      mismatch (e.g. `WS_TOKEN_SECRET` unset or inconsistent across
 *      instances), where every retry is doomed and would otherwise loop
 *      as fast as invalidate+refetch allows; 4403 (forbidden) is a
 *      bug-shaped state and we just stop
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
 * Capped exponential backoff delay (ms) for the nth (0-indexed)
 * consecutive retry attempt. Shared by the generic unclean-close
 * reconnect and the repeated-4401 guard so both back off on the same
 * schedule (1s → 2s → 4s → … → 15s).
 */
function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

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
 *
 * A *single* 4401 is invalidated immediately (see the connect() effect):
 * the common case is a legitimately expired token on a long-open tab,
 * and there is no reason to delay recovery. But if the mint always
 * disagrees with the verifier (e.g. `WS_TOKEN_SECRET` unset with no
 * per-process memoization, or mismatched across instances), *every*
 * mint → connect → 4401 cycle repeats this close code with no natural
 * backpressure — invalidate+refetch+reconnect as fast as the browser
 * can schedule it. Consecutive 4401s (no successful message in between)
 * therefore back off the same way an ordinary unclean close does.
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
 * Resolve the `/notifications` WebSocket base URL. Delegates to the shared
 * `resolveWsUrl` so all three WebSocket namespaces (`/collab`, `/presence`,
 * `/notifications`) share one resolution order: explicit
 * `NEXT_PUBLIC_COLLAB_URL` override → `NEXT_PUBLIC_API_URL` (dev / Vercel) →
 * `window.location` (same-origin image) → localhost fallback. See
 * `resolve-ws-url.ts` for the full rationale.
 *
 * Exported for unit testing — internal otherwise.
 */
export function resolveNotificationsUrl(): string {
  return resolveWsUrl('notifications');
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
 *
 * The query key is scoped by `authedUserId` so a logout → re-login as
 * a different user does NOT serve user A's cached token to user B's
 * handshake. When `authedUserId` is null the query is gated off, so
 * the null-key branch never runs `queryFn`.
 */
function useNotificationsToken(enabled: boolean, authedUserId: string | null) {
  return useQuery({
    queryKey: ['notificationsToken', authedUserId],
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
    enabled: enabled && authedUserId !== null,
    refetchOnWindowFocus: false,
    // The browser firing `online` after a network blip is the cheapest
    // signal that a previously-failed token mint might now succeed —
    // retry then so the bell can resume real-time pushes without a
    // page reload.
    refetchOnReconnect: true,
    // Notifications realtime is auxiliary, but a single failure used
    // to latch the bell into REST-only mode for the rest of the tab's
    // lifetime. A short capped exponential backoff (≤ 15s × 3) gives
    // the connection a fair chance to recover from a transient blip
    // without hammering the server.
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 15_000),
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
  // Scope the token cache by the *authed* user id (not the token's
  // `selfUserId`, which would be circular). On logout → re-login as a
  // different user, the key flips and user A's token cannot be served
  // to user B's effect run.
  const { user } = useAuth();
  const authedUserId = user?.id ?? null;
  const { data: tokenData, isError: tokenError } = useNotificationsToken(enabled, authedUserId);

  const token = tokenData?.token ?? null;
  const selfUserId = tokenData?.selfUserId ?? null;

  // Consecutive-4401 counter for the backoff guard below. A 4401 resolves
  // by invalidating the token query, which (once refetched) changes
  // `token` and re-runs this effect from scratch — so a plain effect-local
  // counter would reset to 0 on every single retry and never see the
  // "consecutive" failures it needs to back off. A ref survives across
  // those effect re-runs; it's reset (inside the effect, below) only on a
  // genuine session change (login/logout), not on our own retry-driven
  // token refresh.
  const invalidTokenAttemptsRef = useRef(0);
  const invalidTokenSessionRef = useRef<string | null>(null);

  useEffect(() => {
    // Track the session key BEFORE the enabled/token guard below, so a
    // logout (authedUserId -> null) is itself recorded as a transition.
    // Otherwise logging out and back in as the SAME user id would look
    // like "no change" from this ref's point of view (old id -> null,
    // stays unobserved while disabled -> new id === old id) and the
    // backoff state from the previous session would leak into the new one.
    if (invalidTokenSessionRef.current !== authedUserId) {
      invalidTokenSessionRef.current = authedUserId;
      invalidTokenAttemptsRef.current = 0;
    }

    if (!enabled || !token || !selfUserId || tokenError) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let invalidTokenTimer: ReturnType<typeof setTimeout> | null = null;
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

    const clearDebounce = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      const url = `${resolveNotificationsUrl()}/${encodeURIComponent(selfUserId)}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        // Catch-up invalidate only on a *real* reconnect (i.e. after at
        // least one backoff-scheduled attempt). The initial connect at
        // mount time is redundant — `useUnreadCount` / `useNotifications`
        // have already fired a fresh REST fetch — and firing it here
        // turns a broken handshake (open → server-reject → close) into
        // an infinite `/notifications/status` storm: every doomed
        // reconnect re-opens, invalidates, refetches, then drops.
        if (reconnectAttempts > 0) {
          scheduleInvalidate();
        }
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
        invalidTokenAttemptsRef.current = 0;
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
        // credential. Cancel any in-flight debounced invalidate first
        // so a pending tick from just-before-close doesn't fire after
        // this branch's queryClient.invalidate (same effect run, same
        // closure — the trailing timer would still hold a live ref).
        if (event.code === NOTIFICATIONS_CLOSE_INVALID_TOKEN) {
          clearDebounce();
          const attempt = invalidTokenAttemptsRef.current;
          invalidTokenAttemptsRef.current += 1;
          const invalidateToken = () => {
            if (disposed) return;
            queryClient.invalidateQueries({ queryKey: ['notificationsToken', authedUserId] });
          };
          if (attempt === 0) {
            // First 4401 since the last successful message: very likely a
            // legitimate expired token, so recover immediately.
            invalidateToken();
          } else {
            // Repeated 4401s with no successful message in between mean
            // every retry is doomed (e.g. a mint/verify secret mismatch) —
            // back off instead of hammering the token endpoint.
            invalidTokenTimer = setTimeout(invalidateToken, backoffDelayMs(attempt - 1));
          }
          return;
        }
        // 4403 (forbidden): a bug-shaped state (we always sign with the
        // authed user id). Looping would just churn the server, so stop.
        // Same debounce-cancel rationale as 4401.
        if (event.code === NOTIFICATIONS_CLOSE_FORBIDDEN) {
          clearDebounce();
          return;
        }
        // Otherwise reconnect with capped exponential backoff.
        const delay = backoffDelayMs(reconnectAttempts);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (invalidTokenTimer) clearTimeout(invalidTokenTimer);
      clearDebounce();
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
  }, [enabled, token, selfUserId, authedUserId, tokenError, queryClient]);
}
