'use client';

import {
  type PresenceCommentChangedMessage,
  type PresencePageUpdatedMessage,
  PresenceServerMessageSchema,
  type PresenceTokenResponse,
  type PresenceViewer,
  WS_CLOSE_CODES,
} from '@crowi/api-contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClientV2 } from './api-client';
import { backoffDelayMs, type CloseCodePolicy, createReconnectingSocket } from './create-reconnecting-socket';
import { createAntiFlickerState, ingestBroadcast, refreshAdmissions, visibleViewers } from './presence-anti-flicker';
import { resolveWsUrl } from './resolve-ws-url';
import { subscribeTokenRefreshed } from './token-refresh-notifier';

/**
 * RFC-0005 Phase 2 — live presence WebSocket client.
 *
 * Drives the presence row above the page title:
 *
 *   1. fetch a short-lived presence token (`GET /pages/:id/presence-token`)
 *   2. open `wss://<host>/presence/<pageId>?token=<token>`
 *   3. send a `{type:"heartbeat"}` every 15s to refresh the Redis TTL
 *   4. parse inbound `{type:"viewers", viewers:[...]}` broadcasts
 *   5. apply the 3s client-side anti-flicker delay before surfacing
 *      newly-joined avatars (see `presence-anti-flicker.ts`)
 *
 * The socket lifecycle (backoff, reconnectAttempts, reset-on-first-message,
 * 4-handler teardown) is delegated to the shared
 * `create-reconnecting-socket.ts` primitive — this hook is a thin consumer
 * that injects `buildUrl` / `onMessage` / `onCloseCode`, plus `onConnecting`
 * / `onOpen` to drive its own `status` state, and keeps only the
 * presence-specific pieces (heartbeat, anti-flicker admission, the
 * reconnect-epoch barrier) for itself.
 *
 * Failure is non-fatal: when the WebSocket never connects (presence
 * handler not deployed, network) the hook reports `status: 'error'`
 * and an empty viewer list, and the presence row hides itself — the
 * rest of the page is unaffected. This mirrors `use-collab-document`'s
 * graceful-degradation contract.
 */

/** Heartbeat cadence — must stay below the server's 30s viewer TTL. */
const PRESENCE_HEARTBEAT_MS = 15_000;

/**
 * `INVALID_TOKEN` / `FORBIDDEN` are shared wire constants (`@crowi/api-contract`,
 * single source across client + server — see `presence/attach.ts`). Presence
 * aliases `FORBIDDEN` to `NO_ACCESS` locally: the grant-based rejection this
 * channel sends reads better under that name than the generic one.
 *
 *   - `NO_ACCESS` (4403) — the viewer's read grant was revoked mid-session.
 *     Reconnecting after this is futile — the server would re-check and
 *     reject again — so the client stops and leaves the row hidden.
 *   - `INVALID_TOKEN` (4401) — the presence token in hand is stale/expired.
 *     Recovery is driven from the 4401 branch in `onCloseCode` below: it
 *     invalidates the presence-token query so a fresh token is refetched
 *     (which re-runs the connection effect), while a capped WS-level retry
 *     keeps a socket in flight meanwhile. See that branch for the full
 *     backoff scheme.
 */
const { INVALID_TOKEN, FORBIDDEN: NO_ACCESS } = WS_CLOSE_CODES;

/**
 * `'connecting'` — an attempt (initial or retry) is in flight, no
 *   transport yet.
 * `'reconnecting'` — the transport is down and a retry IS scheduled
 *   (feature-mobile-presence-card): derived from
 *   `create-reconnecting-socket.ts`'s `onScheduledRetry`, never tracked
 *   with a second timer here. The UI should show a neutral, non-`Live`
 *   state — not the same as `'error'`, which is terminal.
 * `'connected'` — the transport is open. Does NOT by itself mean a
 *   `viewers` frame has been received yet for this connection — see
 *   `hasViewersForConnection` below.
 * `'error'` — terminal: no further retry will be attempted (e.g. a
 *   revoked read grant, or the token request itself failing outright).
 */
export type PresenceStatus = 'connecting' | 'reconnecting' | 'connected' | 'error';

/**
 * Options for {@link usePresence}. `onPageUpdated` is the
 * feature-live-page-content-sync read-side soft-refresh hook: it fires
 * once per `page-updated` frame, including the caller's own save (see
 * its jsdoc below — feature-live-page-sync-reconcile moved self/other
 * silencing to the consumer). It is delivered as a callback (not a
 * returned value) because it is a one-shot event, not render state —
 * mixing it into the returned viewer-list state would churn renders.
 * The callback is read through a ref, so passing a fresh closure each
 * render is fine and never rebuilds the WebSocket.
 */
export interface UsePresenceOptions {
  /**
   * feature-live-page-sync-reconcile — fires for EVERY `page-updated`
   * frame, including the caller's own save. Self/other suppression used
   * to happen inside this hook (`editorUserId === selfUserId`), but a
   * frame carrying the reader's own save from another tab/device must
   * still reach the reconcile fence-counting logic (`pageUpdatedSeq`)
   * and silently swap the cache — only the BANNER is skipped for a self
   * save, and that decision now lives in the consumer (`PageView`'s
   * `handlePageUpdated`), which alone knows `selfUserId` at the same time
   * as the read-old banner state.
   */
  onPageUpdated?: (payload: PresencePageUpdatedMessage) => void;
  /**
   * feature-live-page-comment-sync read-side hook: fires once per
   * `comment-changed` frame that is NOT the caller's own added comment
   * (`changeType === 'added' && actorUserId === selfUserId` is
   * suppressed; `'removed'` always fires — the deleter is unknown at the
   * event layer and a redundant re-fetch is idempotent). Same
   * ref-delivered one-shot contract as `onPageUpdated`.
   */
  onCommentChanged?: (payload: PresenceCommentChangedMessage) => void;
  /**
   * feature-live-page-sync-reconcile — fires once per connection epoch,
   * right after the FIRST `viewers` broadcast of that epoch (never on
   * `onopen`: the transport handshake completes before the server has
   * finished re-checking the read grant + registering the socket in its
   * `connections` map, so a push sent in that gap would never reach a
   * socket the caller believed was already "connected"). The first
   * `viewers` broadcast is proof the socket is registered — see the
   * `reset-backoff` return in `onMessage` below, which uses the same
   * signal. Fires for the FIRST connection epoch too (fresh mount), not
   * just reconnects — the caller (PageView's reconcile) treats every
   * epoch identically (spec §11).
   */
  onReconnected?: () => void;
  /**
   * feature-live-page-sync-reconcile — fires once when this socket is
   * closed with `NO_ACCESS` (4403), whether the rejection happened on
   * the initial connect or mid-session (heartbeat re-check). Does NOT
   * fire for `INVALID_TOKEN` (4401) — that close means only the token is
   * stale, not that the read grant was revoked. This is a "verify, don't
   * assume" signal: `hasReadPermission`'s catch also maps a transient
   * permission-check error to the same 4403, so the consumer must
   * re-check via the authoritative page API before treating this as a
   * real access revocation (spec §10).
   */
  onAccessRevoked?: () => void;
}

export interface UsePresenceResult {
  /**
   * Viewers the UI should render right now — anti-flicker applied, the
   * current user always included if present, ordered by `joinedAt`.
   */
  viewers: PresenceViewer[];
  /** The requesting user's id, so the UI can label "(you)". `null` until the token resolves. */
  selfUserId: string | null;
  /** Connection state. `'error'` ⇒ the presence row should hide itself. */
  status: PresenceStatus;
  /**
   * feature-live-page-sync-reconcile — a frame fence counter, incremented
   * once for every `page-updated` frame received (regardless of self /
   * other). Returned as a `RefObject`, NOT a plain number: the reconcile
   * head-GET reads `.current` once right before issuing the fetch and
   * once right after it resolves, and the two reads must observe the
   * mutation LIVE — destructuring this into a number at the call site
   * would freeze it at the value from the render that called
   * `usePresence`, and a frame arriving during the fetch would never be
   * detected (see spec §3, the same closure trap as `bannerStateRef`).
   */
  pageUpdatedSeq: RefObject<number>;
  /**
   * feature-mobile-presence-card — epoch-scoped flag: `false` from the
   * moment the transport opens (`onOpen`) until this SAME connection has
   * received its first `viewers` frame, then `true` for the rest of that
   * connection's life. A fresh connection (initial mount OR any
   * reconnect) resets it to `false` again. The `Live` indicator is
   * `status === 'connected' && hasViewersForConnection` — `connected`
   * alone only proves the transport handshake finished, not that the
   * server has actually registered this socket and broadcast a snapshot
   * (see the module doc's `hasFiredReconnectedThisEpoch` barrier, which
   * this flag mirrors). Not a freshness guarantee beyond "at least one
   * frame this epoch" — see spec §"接続状態と可視性".
   */
  hasViewersForConnection: boolean;
}

/**
 * feature-mobile-presence-card — whether any OTHER viewer (not self) is
 * currently present. `status === 'error'` (terminal) always resolves to
 * `false` regardless of `viewers` — the desktop `LivePresenceRow` and the
 * mobile `MobilePresenceCard` both hide/collapse on terminal error rather
 * than trusting a possibly-stale last-known viewer list.
 */
export function hasOtherViewers({ status, viewers, selfUserId }: Pick<UsePresenceResult, 'status' | 'viewers' | 'selfUserId'>): boolean {
  return status !== 'error' && viewers.some((v) => v.userId !== selfUserId);
}

/**
 * Resolve the `/presence` WebSocket base URL. Delegates to the shared
 * `resolveWsUrl` so `/presence`, `/collab` and `/notifications` share one
 * resolution order (explicit override → `NEXT_PUBLIC_API_URL` → window.location
 * → localhost). See `resolve-ws-url.ts` for the full rationale.
 */
function resolvePresenceUrl(): string {
  return resolveWsUrl('presence');
}

/**
 * Whether two rendered viewer lists are content-equal. Used to skip a
 * `setViewers` no-op: every broadcast (including a heartbeat-triggered
 * re-broadcast of an unchanged list) calls `visibleViewers`, which
 * always returns a fresh array — without this guard React would
 * re-render the presence row on every heartbeat.
 */
function sameViewers(a: PresenceViewer[], b: PresenceViewer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.userId !== y.userId ||
      x.isEditing !== y.isEditing ||
      x.joinedAt !== y.joinedAt ||
      x.username !== y.username ||
      x.displayName !== y.displayName ||
      x.avatarUrl !== y.avatarUrl
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Options for {@link usePresenceToken}. `getConnectionStatus` lets the
 * parent {@link usePresence} tell the hook whether the live presence
 * WebSocket is currently CONNECTED — see the D1a note on the
 * notifier-driven refetch below.
 */
interface UsePresenceTokenOptions {
  getConnectionStatus?: () => PresenceStatus;
}

/**
 * Fetch the short-lived presence token that the WebSocket presents on
 * connect.
 *
 * Lifecycle (D1, mirroring `useYjsToken`): the presence token authenticates
 * the (re)connect HANDSHAKE only — the presence server verifies it once in
 * `wireConnection` (`presence/attach.ts`) and never re-checks the JWT after
 * upgrade (an established connection only re-validates the READ GRANT on
 * each heartbeat, never the token). So an open socket stays valid past the
 * token's `exp`, and we do NOT proactively refetch on a timer: the pre-fix
 * ~4.5-min `refetchInterval` flipped the connection effect's `token` dep
 * every TTL window, tearing the socket down + re-handshaking — and
 * re-broadcasting the viewer list to every viewer of the page — for zero
 * auth benefit (the "thundering herd" this fix removes).
 *
 * A fresh token is fetched ONLY when (re)connecting:
 *   - on mount (the initial connect), via the query itself;
 *   - on a 4401 close (a stale / expired token), driven by the token-
 *     recovery invalidate in `usePresence`'s `onCloseCode` below;
 *   - on a silent access-token refresh, but ONLY when the connection is NOT
 *     currently established AND the cached token is actually (near-)expired
 *     (the D1a-gated `subscribeTokenRefreshed` effect below).
 */
function usePresenceToken(pageId: string | null | undefined, options?: UsePresenceTokenOptions) {
  const queryClient = useQueryClient();

  // Keep the connection-status getter in a ref so the subscriber effect
  // doesn't re-subscribe when the parent passes a fresh closure each render.
  const getConnectionStatusRef = useRef(options?.getConnectionStatus);
  useEffect(() => {
    getConnectionStatusRef.current = options?.getConnectionStatus;
  }, [options?.getConnectionStatus]);

  // §4 / H7 / D1a — re-fetch the presence token on a silent access-token
  // refresh ONLY when the connection is NOT currently established AND the
  // cached presence token is actually (near-)expired, mirroring `useYjsToken`.
  // Two guards, both needed:
  //   - D1a: while `connected`, the established socket stays authenticated
  //     for its whole life regardless of the token's `exp` (the server never
  //     re-verifies the JWT after upgrade), so refetching would only churn
  //     the live socket for nothing — skip entirely, even past the TTL.
  //   - H7: otherwise (connecting / error / not yet connected), a token still
  //     well within its TTL is left in place so a healthy access-token
  //     refresh doesn't needlessly rebuild the socket; only a (near-)expired
  //     token is refetched.
  // This is a SEPARATE trigger from both (a) the 4401 token-recovery
  // invalidate in `usePresence`'s `onCloseCode` (which recovers an
  // already-dead socket) and (b) `session-reauth-context`'s post-reauth
  // `refetchTokens()`, which invalidates this query directly via queryClient
  // and INTENTIONALLY bypasses the D1a gate to force a socket rebuild after
  // re-authentication. This path only keeps a still-live socket's token from
  // silently lapsing.
  useEffect(() => {
    if (!pageId) return;
    return subscribeTokenRefreshed(() => {
      if (getConnectionStatusRef.current?.() === 'connected') return;
      const cached = queryClient.getQueryData<PresenceTokenResponse>(['presenceToken', pageId]);
      const expiresInMs = cached ? Date.parse(cached.expiresAt) - Date.now() : -1;
      if (expiresInMs > 30_000) return;
      void queryClient.invalidateQueries({ queryKey: ['presenceToken', pageId], refetchType: 'active' });
    });
  }, [pageId, queryClient]);

  return useQuery({
    queryKey: ['presenceToken', pageId],
    queryFn: async (): Promise<PresenceTokenResponse> => {
      if (!pageId) throw new Error('pageId is required for usePresenceToken');
      const response = await apiClientV2.pages[':id']['presence-token'].$get({ param: { id: pageId } });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error
            ? String(body.error.message)
            : 'Failed to issue presence token';
        throw new Error(message);
      }
      return response.json();
    },
    enabled: Boolean(pageId),
    // D1 — NO proactive `refetchInterval`. An established connection persists
    // past the token's `exp` (the server never re-verifies the JWT after
    // upgrade); refetching on a timer would only flip the connection effect's
    // `token` dep and churn the live socket. Recovery refetches go through
    // explicit `invalidateQueries` instead: the 4401 token-recovery path in
    // `onCloseCode` below, the D1a-gated silent-refresh effect above, or
    // `session-reauth-context`'s post-reauth `refetchTokens()`.
    refetchOnWindowFocus: false,
    // Long-lived from the query's perspective — a staleness-driven background
    // refetch would rebuild the socket for nothing (same reasoning as the
    // removed `refetchInterval`). Recovery is always explicit.
    staleTime: Infinity,
    // §4 — presence is auxiliary UI, but a single failed token request
    // (e.g. a transient 401 that the next attempt's silent refresh
    // fixes) used to hide the row outright. Bumped 1 → 3 so a brief auth
    // blip self-heals before the row disappears; still bounded so a hard
    // failure (handler not deployed) settles quickly.
    retry: 3,
  });
}

export function usePresence(pageId: string | null | undefined, options?: UsePresenceOptions): UsePresenceResult {
  const queryClient = useQueryClient();

  // feature-presence-consistency-fixes defect 3 — the rendered viewer list
  // is tagged with the `pageId` it was computed for, and the RETURN value
  // below (not an effect) re-derives it against the CURRENT `pageId`
  // argument on every render. A bare `useState<PresenceViewer[]>` used to
  // rely on a `useEffect(() => setViewers([]), [pageId])` to clear stale
  // state on navigation — but an effect only runs AFTER a render commits,
  // so the very FIRST render with the new `pageId` (P2) still returned the
  // OLD page's (P1's) viewer list, and — since P2's presence token has not
  // resolved yet at that point — `selfUserId` was often `null`, which could
  // make one of P1's viewers appear to satisfy an "not me" check on P2's
  // screen. Deriving synchronously from a tagged tuple closes that window:
  // a mismatched tag renders `[]` immediately, with no effect-flush lag.
  const [viewersState, setViewersState] = useState<{ pageId: string | null | undefined; viewers: PresenceViewer[] }>({
    pageId,
    viewers: [],
  });
  const [status, setStatus] = useState<PresenceStatus>('connecting');

  // feature-mobile-presence-card — epoch-scoped "at least one viewers
  // frame received on THIS connection" flag. Reset to `false` in `onOpen`
  // (every attempt, including reconnects) and flipped to `true` the first
  // time `onMessage` parses a `viewers` frame this epoch — mirrors
  // `hasFiredReconnectedThisEpoch`'s epoch-scoping below, just exposed to
  // the caller instead of staying a private effect-local flag.
  const [hasViewersForConnection, setHasViewersForConnection] = useState(false);

  // D1a — expose the LIVE connection status to `usePresenceToken` so its
  // notifier-driven refetch can skip while we're `connected` (an established
  // socket doesn't care that the token's TTL lapsed; refetching would only
  // churn the live socket). `status` is `useState`, driven from the socket
  // callbacks below; `applyStatus` mirrors every change into `statusRef`
  // SYNCHRONOUSLY so the getter reads the current value without the one-render
  // lag a `useEffect(() => { statusRef.current = status })` copy would add.
  const statusRef = useRef<PresenceStatus>('connecting');
  const applyStatus = useCallback((next: PresenceStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  const getConnectionStatus = useCallback(() => statusRef.current, []);

  const { data: tokenData, isError: tokenError } = usePresenceToken(pageId, { getConnectionStatus });

  // The anti-flicker state survives reconnects within the same page
  // session, so a viewer admitted before a blip stays admitted.
  const flickerRef = useRef(createAntiFlickerState());

  // Keep the latest `onPageUpdated` in a ref so the WebSocket effect
  // (deps: pageId / token / selfUserId) never rebuilds when the callback
  // identity changes across renders — the same pattern the notifications
  // socket uses for its queryClient closure.
  const onPageUpdatedRef = useRef(options?.onPageUpdated);
  useEffect(() => {
    onPageUpdatedRef.current = options?.onPageUpdated;
  });

  // Same ref pattern for the comment-changed callback.
  const onCommentChangedRef = useRef(options?.onCommentChanged);
  useEffect(() => {
    onCommentChangedRef.current = options?.onCommentChanged;
  });

  // Same ref pattern for the reconcile-barrier / access-revoked callbacks.
  const onReconnectedRef = useRef(options?.onReconnected);
  useEffect(() => {
    onReconnectedRef.current = options?.onReconnected;
  });
  const onAccessRevokedRef = useRef(options?.onAccessRevoked);
  useEffect(() => {
    onAccessRevokedRef.current = options?.onAccessRevoked;
  });

  // Frame fence counter (spec §3) — a `useRef`, not `useState`: a render
  // is neither required nor desired on every `page-updated` frame, and
  // the reconcile consumer must read `.current` live at two points
  // spanning an `await` (see `UsePresenceResult.pageUpdatedSeq` above).
  const pageUpdatedSeqRef = useRef(0);

  // Consecutive-4401 counter for the token-recovery backoff in `onCloseCode`
  // below (mirrors `use-notifications-socket.ts`). A 4401 that genuinely
  // resolves invalidates the presence-token query, which — once refetched
  // with a WORKING token — changes `token` and re-runs the connection effect
  // from scratch, so an effect-LOCAL counter would reset to 0 on every
  // retry-driven re-run and never accumulate the "consecutive" failures it
  // needs to back off. A ref survives across those re-runs; it is reset only
  // on a genuine page change (tracked by `invalidTokenSessionRef`) or once a
  // valid `viewers` frame proves the connection healthy (in `onMessage`).
  const invalidTokenAttemptsRef = useRef(0);
  const invalidTokenSessionRef = useRef<string | null | undefined>(undefined);

  const token = tokenData?.token ?? null;
  const selfUserId = tokenData?.selfUserId ?? null;

  // Token request failed outright — surface 'error' so the row hides.
  useEffect(() => {
    if (tokenError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      applyStatus('error');
    }
  }, [tokenError, applyStatus]);

  useEffect(() => {
    // Reset the consecutive-4401 backoff on a genuine page change (a new
    // presence session), but NOT on our own token-recovery re-runs (same
    // `pageId`, fresh `token`) — those must accumulate so a doomed-token
    // storm keeps backing off. Tracked here rather than in the page-change
    // effect below so it observes the change before the first close can fire.
    if (invalidTokenSessionRef.current !== pageId) {
      invalidTokenSessionRef.current = pageId;
      invalidTokenAttemptsRef.current = 0;
    }

    if (!pageId || !token) return;

    const flicker = flickerRef.current;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let admissionTimer: ReturnType<typeof setTimeout> | null = null;
    let invalidTokenTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    // feature-live-page-sync-reconcile — one connection "epoch" is one
    // successful transport handshake (initial mount OR a reconnect).
    // Reset in `onOpen` below so each epoch gets its own one-shot latch
    // for `onReconnected`; by the time any message could arrive, `onOpen`
    // has already run exactly once for that attempt.
    let hasFiredReconnectedThisEpoch = false;

    // feature-presence-consistency-fixes defect 2 — the highest `viewers`
    // frame `generation` applied so far THIS epoch (reset in `onOpen`,
    // exactly like `hasFiredReconnectedThisEpoch`). A frame whose
    // `generation` is not higher than this is a stale, out-of-order
    // broadcast (the server's own `listViewers` read completed later than
    // a broadcast it raced but was DISPATCHED before) and must be
    // discarded instead of overwriting the anti-flicker state with older
    // data than what is already showing.
    let lastAppliedGeneration = 0;

    // Recompute the rendered list from the anti-flicker state and
    // schedule the next admission re-check at the earliest `dueAt`. Tags
    // the written state with THIS effect's own `pageId` (defect 3) so a
    // write that lands after `pageId` has already changed (a message in
    // flight when navigation starts) is rendered as `[]` rather than
    // bleeding into the new page — see the `viewersState`-derivation at
    // the bottom of the hook.
    const project = (dueAt: number | null) => {
      const next = visibleViewers(flicker, selfUserId);
      setViewersState((prev) => (prev.pageId === pageId && sameViewers(prev.viewers, next) ? prev : { pageId, viewers: next }));
      if (admissionTimer) {
        clearTimeout(admissionTimer);
        admissionTimer = null;
      }
      if (dueAt !== null) {
        const delay = Math.max(0, dueAt - Date.now());
        admissionTimer = setTimeout(() => {
          if (disposed) return;
          const { dueAt: next } = refreshAdmissions(flicker, Date.now());
          project(next);
        }, delay);
      }
    };

    const socket = createReconnectingSocket({
      buildUrl: () => `${resolvePresenceUrl()}/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`,

      // Fires before EVERY connection attempt, including reconnects — the
      // pre-extraction `connect()` closure called `setStatus('connecting')`
      // at the very top of itself for the same reason: once a close has
      // flipped the row to 'error', the next attempt (whether immediate or
      // after the backoff delay) should show 'connecting' again rather
      // than leaving the row stuck on 'error' until (if ever) the retry
      // actually succeeds.
      onConnecting: () => {
        applyStatus('connecting');
      },

      onOpen: () => {
        applyStatus('connected');
        hasFiredReconnectedThisEpoch = false;
        // A new epoch starts its own generation lineage — see
        // `lastAppliedGeneration`'s doc comment above.
        lastAppliedGeneration = 0;
        // feature-mobile-presence-card — every fresh attempt starts its
        // own "have we seen a viewers frame yet" epoch, mirroring
        // `hasFiredReconnectedThisEpoch` above.
        setHasViewersForConnection(false);
        // Fire one heartbeat immediately, then on the 15s cadence.
        const beat = () => {
          socket.send(JSON.stringify({ type: 'heartbeat' }));
        };
        beat();
        heartbeatTimer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
      },

      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Non-JSON frame — ignore, presence only speaks JSON.
          return;
        }
        const message = PresenceServerMessageSchema.safeParse(parsed);
        if (!message.success) return;

        // feature-live-page-content-sync / feature-live-page-sync-reconcile:
        // a `page-updated` frame drives the read-side soft-refresh, not the
        // viewer list. The frame fence counter is incremented for EVERY
        // frame (self included) — the reconcile head-GET fence needs to
        // know a save happened at all, regardless of who made it — and the
        // callback likewise now fires unconditionally; self/other silencing
        // of the BANNER (not the cache swap) moved to the consumer
        // (`PageView`), which is the only place that can consult the
        // read-old banner state at the same time (spec §7). Note this does
        // NOT reset the backoff — only a `viewers` broadcast (below) does.
        if (message.data.type === 'page-updated') {
          pageUpdatedSeqRef.current += 1;
          onPageUpdatedRef.current?.(message.data);
          return;
        }

        // feature-live-page-comment-sync: a `comment-changed` frame
        // drives the live comment list, not the viewer list. Suppress the
        // caller's own added comment (`actorUserId === selfUserId`); a
        // `removed` frame carries no actorUserId and always fires (the
        // deleter is unknown at the event layer, and a redundant re-fetch
        // is idempotent). A `null` selfUserId (token not yet resolved) is
        // treated as "not me" so the signal is never silently dropped.
        if (message.data.type === 'comment-changed') {
          const isOwnAdd = message.data.changeType === 'added' && message.data.actorUserId === selfUserId;
          if (!isOwnAdd) {
            onCommentChangedRef.current?.(message.data);
          }
          return;
        }

        // A parsed `viewers` broadcast proves the connection is truly
        // established — the server rejects a bad token *before* sending
        // any frame. Resetting the backoff here (rather than on `onopen`,
        // which fires for the doomed handshake too) stops a
        // handshake-then-reject case, e.g. an expired token, from
        // pinning the reconnect delay at its 1s floor forever.
        // feature-live-page-sync-reconcile — the FIRST `viewers` broadcast
        // of this epoch is the reconnect barrier (spec §11): it proves the
        // socket is registered in the server's `connections` map, so a
        // reconcile GET fired from here observes any update saved before
        // this point. Fires once per epoch, including the very first
        // (fresh-mount) connection — the consumer treats every epoch alike.
        if (!hasFiredReconnectedThisEpoch) {
          hasFiredReconnectedThisEpoch = true;
          onReconnectedRef.current?.();
        }
        // feature-mobile-presence-card — ANY viewers frame this epoch
        // (including one about to be discarded as stale by the
        // generation check below) proves the connection has delivered at
        // least one snapshot; the `Live` indicator gates on this rather
        // than on `status === 'connected'` alone (see the flag's doc
        // comment on `UsePresenceResult`).
        setHasViewersForConnection(true);
        // A healthy connection also resets the consecutive-4401 counter, so a
        // LATER stale-token close starts its recovery from an immediate
        // invalidate again rather than inheriting an old backoff rung.
        invalidTokenAttemptsRef.current = 0;

        // feature-presence-consistency-fixes defect 2 — discard a frame
        // whose `generation` does not advance past the highest one already
        // applied this epoch: the server assigns `generation` at DISPATCH
        // time, but the underlying `listViewers` read can resolve out of
        // order, so a lower (or equal) generation arriving now is
        // necessarily a stale broadcast that raced ahead of a NEWER one
        // already rendered. The connection itself is still healthy — the
        // barrier / backoff-reset above already accounted for that — only
        // the viewer-list STATE UPDATE is skipped.
        if (message.data.generation <= lastAppliedGeneration) {
          return 'reset-backoff';
        }
        lastAppliedGeneration = message.data.generation;

        const { dueAt } = ingestBroadcast(flicker, message.data.viewers, Date.now());
        project(dueAt);
        return 'reset-backoff';
      },

      onCloseCode: (code): CloseCodePolicy => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        // feature-mobile-presence-card — clear any pending admission
        // promotion on close too. The anti-flicker STATE (`flicker`)
        // intentionally survives a reconnect (so the last known avatars
        // stay put through a blip), but a promotion that was scheduled
        // for a NOW-dead connection must not silently fire once the next
        // connection is up — the new epoch's own first `viewers` frame
        // (via `ingestBroadcast`) re-schedules admission from scratch, so
        // nothing is lost, only the stale in-flight timer is dropped.
        if (admissionTimer) {
          clearTimeout(admissionTimer);
          admissionTimer = null;
        }
        // Default to terminal 'error' up front — it applies to every close
        // code, before we branch on which one. This does NOT gate the 4401
        // recovery below: that invalidate calls `queryClient.invalidateQueries`
        // directly, which never runs the `subscribeTokenRefreshed` callback
        // where the D1a `=== 'connected'` gate lives, so the refetch fires
        // regardless of when `applyStatus('error')` runs. For every
        // non-'stop' policy below, the primitive calls `onScheduledRetry`
        // synchronously right after this function returns (same tick, same
        // React batch), which flips this to 'reconnecting' — so 'error' is
        // only ever the value actually observed after a 'stop' close.
        applyStatus('error');
        // A revoked read grant (4403) would just be rejected again on an
        // immediate retry — stop reconnecting. The consumer is notified so it
        // can re-validate; a restored grant is picked up on the next connect
        // this effect makes when it re-runs for some other reason.
        if (code === NO_ACCESS) {
          // feature-live-page-sync-reconcile — verify-first (spec §10):
          // this close code also fires for a merely TRANSIENT permission-
          // check error, so the consumer re-validates via the page API
          // rather than assuming the grant is really gone.
          onAccessRevokedRef.current?.();
          return 'stop';
        }
        // 4401 (stale / expired token): without the removed `refetchInterval`
        // nothing else re-mints the token, so this close is now the sole
        // recovery trigger. Mirrors `use-notifications-socket.ts`: invalidate
        // the presence-token query so a fresh token is refetched — once React
        // re-renders with it, `token` flips, the effect re-runs, and a new
        // handshake goes out (the REAL fix). Two backoffs run here on the same
        // capped schedule, deliberately separate:
        //   - the WS-level retry — `'reconnect'` on the first 4401 since the
        //     last healthy frame, `'backoff-retry'` after that — reusing the
        //     SAME still-stale token, a stopgap until the effect re-runs;
        //   - the token-mint invalidate — immediate on the first 4401 (the
        //     common expired-token case), then paced by `invalidTokenTimer`
        //     via the primitive's exported `backoffDelayMs` so a mint/verify
        //     secret mismatch (every retry doomed) can't hammer the endpoint.
        // Aligning with notifications rather than the old `'stop'` also closes
        // the byte-identical-JWT hole: had `'stop'` remained and the refetch
        // returned a token whose `iat`/`exp` happened to match, `token` would
        // not change, the effect would never re-run, and presence would die
        // permanently — the WS-level retry keeps a live socket in flight
        // meanwhile.
        if (code === INVALID_TOKEN) {
          const attempt = invalidTokenAttemptsRef.current;
          invalidTokenAttemptsRef.current += 1;
          const invalidateToken = () => {
            if (disposed) return;
            void queryClient.invalidateQueries({ queryKey: ['presenceToken', pageId] });
          };
          if (attempt === 0) {
            invalidateToken();
          } else {
            invalidTokenTimer = setTimeout(invalidateToken, backoffDelayMs(attempt - 1));
          }
          return attempt === 0 ? 'reconnect' : 'backoff-retry';
        }
        // Otherwise reconnect with capped exponential backoff.
        return 'backoff-retry';
      },

      // feature-mobile-presence-card — fires right after `onCloseCode`
      // above for every policy EXCEPT 'stop', i.e. exactly when a retry
      // has actually been scheduled. See `PresenceStatus`'s doc comment:
      // 'reconnecting' is derived from "a retry is scheduled", not
      // tracked with an independent timer here.
      onScheduledRetry: () => {
        applyStatus('reconnecting');
      },
    });

    socket.start();

    return () => {
      disposed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (admissionTimer) clearTimeout(admissionTimer);
      if (invalidTokenTimer) clearTimeout(invalidTokenTimer);
      socket.stop();
    };
  }, [pageId, token, selfUserId, applyStatus, queryClient]);

  // Clear the rendered list when navigating away from a page so a
  // stale stack never bleeds across page views. This still matters even
  // though the RETURN below already gates synchronously (see there): this
  // effect is what actually advances `viewersState`'s tag to the new
  // `pageId` (with an empty list) once the navigation commits, closing
  // the mismatch window the gate covers in the meantime.
  useEffect(() => {
    flickerRef.current = createAntiFlickerState();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewersState({ pageId, viewers: [] });
    // A brand new page session has no confirmed viewers frame yet either
    // — the connect effect's own `onOpen` will also reset this once its
    // (possibly still-in-flight) connection opens, but resetting here too
    // closes the same navigation-window `viewersState` handles above.
    setHasViewersForConnection(false);
  }, [pageId]);

  // feature-presence-consistency-fixes defect 3 — re-derive the RETURNED
  // viewers/selfUserId synchronously at render time against the CURRENT
  // `pageId` argument, rather than trusting `viewersState` to already have
  // caught up. `viewersState.pageId` only advances once either the
  // pageId-change effect above or the connection effect's own `project()`
  // runs — both AFTER the render commits — so on the very first render
  // following a `pageId` change, this comparison is what actually prevents
  // the previous page's viewer list (and its viewers' identities) from
  // rendering, even for that one render. `selfUserId` is gated the same
  // way: it does not itself carry stale data (its query key is scoped by
  // `pageId`), but gating it in lockstep with `viewers` means a consumer
  // never observes a "self" id paired with a viewer list that is not
  // actually this page's.
  const pageIdMatchesRenderedViewers = viewersState.pageId === pageId;
  const activeViewers = pageIdMatchesRenderedViewers ? viewersState.viewers : [];
  const activeSelfUserId = pageIdMatchesRenderedViewers ? selfUserId : null;

  return {
    viewers: activeViewers,
    selfUserId: activeSelfUserId,
    status,
    pageUpdatedSeq: pageUpdatedSeqRef,
    hasViewersForConnection,
  };
}
