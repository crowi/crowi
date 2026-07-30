'use client';

import { NotificationsServerMessageSchema, type NotificationsTokenResponse, WS_CLOSE_CODES } from '@crowi/api-contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiClient } from './api-client';
import { backoffDelayMs, type CloseCodePolicy, createReconnectingSocket } from './create-reconnecting-socket';
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
 *      `notificationsToken` query so a refetch yields a fresh token +
 *      (once React re-renders with it) a new effect run + a new
 *      handshake; the first 4401 in a row invalidates immediately (the
 *      common case: a genuinely expired token after a long-open tab),
 *      but each further 4401 without an intervening successful message
 *      applies the same capped backoff as a normal reconnect before
 *      invalidating again — defense in depth against a mint/verify
 *      secret mismatch (e.g. `WS_TOKEN_SECRET` unset or inconsistent
 *      across instances), where every retry is doomed and would
 *      otherwise loop as fast as invalidate+refetch allows; 4403
 *      (forbidden) is a bug-shaped state and we just stop
 *
 * The socket lifecycle (backoff, reconnectAttempts, reset-on-first-message,
 * 4-handler teardown) is delegated to the shared
 * `create-reconnecting-socket.ts` primitive. This hook is a thin consumer
 * that injects `buildUrl` / `onMessage` / `onCloseCode`, keeping only the
 * notification-specific pieces (the debounced invalidate, the two-stage
 * 4401 policy) for itself. Two DIFFERENT things are paced by (the same
 * shape of) capped exponential backoff here, deliberately kept separate:
 *
 *   - the WS-level reconnect attempt itself — expressed as the
 *     primitive's own `'reconnect'` (first 4401 since the last reset) /
 *     `'backoff-retry'` (every one after that) policy return value (see
 *     AC-3), so the primitive's own internal scheduling drives it; both
 *     retry with the SAME (still stale) token baked into `buildUrl`'s
 *     closure, so they are a stopgap, not the actual fix.
 *   - the `notificationsToken` mint HTTP call — paced by this hook's own
 *     `invalidTokenTimer`, reusing the primitive's exported
 *     `backoffDelayMs` (with its defaults — the same ones the primitive
 *     applies to its own retries, so the two schedules are identical by
 *     construction rather than by matching literals). This one is NOT
 *     delegated to the primitive itself: unlike an ordinary reconnect,
 *     each mint is a distinct HTTP request to a DIFFERENT endpoint than
 *     the WebSocket upgrade, and in the secret-mismatch storm case the
 *     resulting token refetch can resolve (and re-run this whole effect
 *     with a brand-new, still-doomed primitive instance) far faster
 *     than the WS-level backoff timer above would ever get to fire —
 *     so the WS-level policy alone cannot bound the mint rate, and
 *     dropping this second timer would reopen the exact storm
 *     `95f7862d` fixed.
 *
 * The *actual* fix for a genuinely stale token runs outside this
 * primitive instance either way: once `notificationsToken` refetches and
 * resolves to a real fresh token, `token` changes, the effect re-runs
 * from scratch, and the cleanup (`socket.stop()`) cancels whatever retry
 * this instance had pending.
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

/**
 * Client-side debounce window for batching `changed` ticks. A
 * mention-everyone publish can produce a burst of ticks for one
 * recipient (one per activity row); collapsing them to one
 * `invalidateQueries` call keeps the bell from N-rendering in
 * quick succession.
 */
const INVALIDATE_DEBOUNCE_MS = 200;

/**
 * `INVALID_TOKEN` / `FORBIDDEN` are shared wire constants
 * (`@crowi/api-contract`, single source across client + server — see
 * `notifications/attach.ts`).
 *
 *   - `INVALID_TOKEN` (4401) — the token in hand is stale / expired. See
 *     the module doc: the real recovery goes through invalidating the
 *     `notificationsToken` query, paced separately from (though on the
 *     same backoff shape as) this instance's own `'reconnect'` /
 *     `'backoff-retry'` WS-level retries, which reuse the same,
 *     still-stale token and are only ever a stopgap until the effect
 *     re-runs with a fresh one.
 *   - `FORBIDDEN` (4403) — the token's `selfUserId` did not match the URL
 *     path. In practice this only fires on a bug-shaped request (we
 *     always sign with the authed user id), but stop reconnecting all
 *     the same — looping would just churn the server.
 */
const { INVALID_TOKEN, FORBIDDEN } = WS_CLOSE_CODES;

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
      const response = await apiClient.notifications.token.$get();
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
    // Same capped schedule the WS retries use — `backoffDelayMs`'s own
    // defaults. Wrapped rather than passed by reference: react-query calls
    // `retryDelay(attemptIndex, error)`, and `error` would land in the
    // `baseMs` parameter.
    retryDelay: (attemptIndex) => backoffDelayMs(attemptIndex),
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

  // Consecutive-4401 counter for the reconnect/backoff policy below. A
  // 4401 that genuinely resolves invalidates the token query, which (once
  // refetched with a WORKING token) changes `token` and re-runs this
  // effect from scratch — so a plain effect-local counter would reset to
  // 0 on every single retry-driven effect run and never see the
  // "consecutive" failures it needs to back off. A ref survives across
  // those effect re-runs; it's reset (inside the effect, below) only on a
  // genuine session change (login/logout), not on our own retry-driven
  // token refresh. `onMessage` also resets it — see below.
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

    let invalidTokenTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    // Whether THIS effect run's primitive has already seen a close before
    // (of any kind, not just a successful `onOpen`). Mirrors the
    // pre-extraction `reconnectAttempts > 0` check, but keyed off "has
    // this instance ever closed" rather than "has this instance ever
    // opened" — a connection that fails before its first `onopen` (e.g. a
    // network blip) still counts as a retry once it eventually opens, so
    // the catch-up invalidate must still fire on that first successful
    // open. Only a genuine first-ever connection (no prior close) skips it.
    let hasClosedBefore = false;

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

    const socket = createReconnectingSocket({
      buildUrl: () => `${resolveNotificationsUrl()}/${encodeURIComponent(selfUserId)}?token=${encodeURIComponent(token)}`,

      onOpen: () => {
        // Catch-up invalidate only on a *real* reconnect (i.e. after at
        // least one prior close in this effect run — see `hasClosedBefore`
        // above). The initial connect at mount time is redundant —
        // `useUnreadCount` / `useNotifications` have already fired a fresh
        // REST fetch — and firing it here turns a broken handshake (open →
        // server-reject → close) into an infinite `/notifications/status`
        // storm: every doomed reconnect re-opens, invalidates, refetches,
        // then drops.
        if (hasClosedBefore) {
          scheduleInvalidate();
        }
      },

      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Non-JSON frame — ignore, notifications only speaks JSON.
          return;
        }
        const message = NotificationsServerMessageSchema.safeParse(parsed);
        if (!message.success) return;
        // A parsed server message proves the connection is truly
        // established — the server rejects a bad token *before*
        // sending any frame. Resetting the backoff here (rather than on
        // `onopen`, which fires for the doomed handshake too) so a
        // handshake-then-reject loop doesn't pin the reconnect delay at
        // its 1s floor forever. Same pattern as `usePresence`.
        invalidTokenAttemptsRef.current = 0;
        // Also clear the catch-up latch: we are now healthily connected, so a
        // LATER 4401 retry loop (which does not set `hasClosedBefore`) must not
        // inherit a `true` left over from an earlier ordinary close in this
        // same effect run — otherwise each doomed retry's `onopen` would fan
        // out a catch-up refetch, the very storm `onOpen`'s guard prevents.
        hasClosedBefore = false;
        scheduleInvalidate();
        return 'reset-backoff';
      },

      onCloseCode: (code): CloseCodePolicy => {
        // NOTE: `hasClosedBefore` is set only on the ordinary-close path at
        // the bottom, NOT here. The server completes the upgrade and only
        // then verifies the token (`notifications/attach.ts` hands the
        // socket to `wireConnection` from inside `handleUpgrade`), so a
        // doomed 4401 retry still fires `onopen` — flagging every close
        // here would make each rejected handshake in a 4401 loop pass
        // `onOpen`'s guard and fan out a full notification refetch, i.e.
        // exactly the storm that guard exists to prevent, merely paced by
        // the backoff. A rejected handshake never established a session,
        // so there is nothing to catch up on.
        // 4401 (stale token): kick the token query to refetch — the new
        // token (once React re-renders with it) flips the effect's
        // `token` dep, which re-runs the effect and handshakes anew with
        // a brand-new primitive instance; that is the *real* fix. Two
        // backoffs run here, deliberately kept separate (see the module
        // doc): the WS-level retry (AC-3 — `'reconnect'` on the first
        // 4401 since the last successful message, `'backoff-retry'` on
        // every one after that, both against the SAME still-stale token)
        // and the token-mint HTTP call, paced by `invalidTokenTimer`
        // below on the identical schedule via the primitive's exported
        // `backoffDelayMs`. Cancel any in-flight debounced invalidate
        // first so a pending tick from just-before-close doesn't fire
        // after this branch's queryClient.invalidate (same effect run,
        // same closure — the trailing timer would still hold a live ref).
        if (code === INVALID_TOKEN) {
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
          return attempt === 0 ? 'reconnect' : 'backoff-retry';
        }
        // 4403 (forbidden): a bug-shaped state (we always sign with the
        // authed user id). Looping would just churn the server, so stop.
        // Same debounce-cancel rationale as 4401.
        if (code === FORBIDDEN) {
          clearDebounce();
          return 'stop';
        }
        // An ordinary unclean close (1006 etc.): the session may well have
        // been live, so the reopen IS a real reconnect that may have missed
        // ticks — arm `onOpen`'s catch-up invalidate for it.
        hasClosedBefore = true;
        return 'backoff-retry';
      },
    });

    socket.start();

    return () => {
      disposed = true;
      if (invalidTokenTimer) clearTimeout(invalidTokenTimer);
      clearDebounce();
      socket.stop();
    };
  }, [enabled, token, selfUserId, authedUserId, tokenError, queryClient]);
}
