'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PresenceViewersMessageSchema, type PresenceTokenResponse, type PresenceViewer } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import { createAntiFlickerState, ingestBroadcast, refreshAdmissions, visibleViewers } from './presence-anti-flicker';

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
 * Failure is non-fatal: when the WebSocket never connects (presence
 * handler not deployed, network) the hook reports `status: 'error'`
 * and an empty viewer list, and the presence row hides itself — the
 * rest of the page is unaffected. This mirrors `use-collab-document`'s
 * graceful-degradation contract.
 */

/** Heartbeat cadence — must stay below the server's 30s viewer TTL. */
const PRESENCE_HEARTBEAT_MS = 15_000;

/** WebSocket reconnect backoff after an unclean close, capped. */
const PRESENCE_RECONNECT_BASE_MS = 1_000;
const PRESENCE_RECONNECT_MAX_MS = 15_000;

/**
 * Close code the presence server sends when the viewer's read grant
 * was revoked mid-session (`WS_CLOSE.NO_ACCESS` in `presence/attach.ts`).
 * Reconnecting after this is futile — the server would re-check and
 * reject again — so the client stops and leaves the row hidden.
 */
const PRESENCE_CLOSE_NO_ACCESS = 4403;

/**
 * Close code for an invalid / expired presence token (`WS_CLOSE
 * .INVALID_TOKEN` in `presence/attach.ts`). The token in hand is stale,
 * so an immediate retry with the *same* token just loops — the client
 * stops and waits for `usePresenceToken` to refetch a fresh one, which
 * re-runs the connection effect.
 */
const PRESENCE_CLOSE_INVALID_TOKEN = 4401;

export type PresenceStatus = 'connecting' | 'connected' | 'error';

interface UsePresenceResult {
  /**
   * Viewers the UI should render right now — anti-flicker applied, the
   * current user always included if present, ordered by `joinedAt`.
   */
  viewers: PresenceViewer[];
  /** The requesting user's id, so the UI can label "(you)". `null` until the token resolves. */
  selfUserId: string | null;
  /** Connection state. `'error'` ⇒ the presence row should hide itself. */
  status: PresenceStatus;
}

/**
 * Resolve the `/presence` WebSocket base URL. Mirrors
 * `use-collab-document`'s `resolveCollabUrl` exactly — same env
 * precedence (`NEXT_PUBLIC_COLLAB_URL` wins, else derive from
 * `NEXT_PUBLIC_API_URL`) because `/presence` and `/collab` attach to
 * the same api `http.Server`. We deliberately do NOT use
 * `window.location` — Next.js `rewrites()` is HTTP-only and silently
 * drops WebSocket `upgrade` events in the dev split.
 */
function resolvePresenceUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_URL;
  const base = fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/collab$/, '') : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4301';
  return `${base.replace(/^http/, 'ws')}/presence`;
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
 * Fetch the short-lived presence token. Refetches ~30s before expiry
 * so the WebSocket can be reconnected with a fresh token before the
 * server would otherwise reject it (mirrors `use-yjs-token`).
 */
function usePresenceToken(pageId: string | null | undefined) {
  return useQuery<PresenceTokenResponse>({
    queryKey: ['presenceToken', pageId],
    queryFn: async () => {
      if (!pageId) throw new Error('pageId is required for usePresenceToken');
      const result = await apiClient.presence.getPresenceToken({ params: { id: pageId } });
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to issue presence token',
      });
    },
    enabled: Boolean(pageId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const msUntilRefresh = Date.parse(data.expiresAt) - Date.now() - 30_000;
      return Math.max(30_000, msUntilRefresh);
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    // Presence is auxiliary UI — one failed token request just hides
    // the row, no need to hammer the endpoint.
    retry: 1,
  });
}

export function usePresence(pageId: string | null | undefined): UsePresenceResult {
  const { data: tokenData, isError: tokenError } = usePresenceToken(pageId);

  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const [status, setStatus] = useState<PresenceStatus>('connecting');

  // The anti-flicker state survives reconnects within the same page
  // session, so a viewer admitted before a blip stays admitted.
  const flickerRef = useRef(createAntiFlickerState());

  const token = tokenData?.token ?? null;
  const selfUserId = tokenData?.selfUserId ?? null;

  // Token request failed outright — surface 'error' so the row hides.
  useEffect(() => {
    if (tokenError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('error');
    }
  }, [tokenError]);

  useEffect(() => {
    if (!pageId || !token) return;

    const flicker = flickerRef.current;
    let socket: WebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let admissionTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let disposed = false;

    // Recompute the rendered list from the anti-flicker state and
    // schedule the next admission re-check at the earliest `dueAt`.
    const project = (dueAt: number | null) => {
      const next = visibleViewers(flicker, selfUserId);
      setViewers((prev) => (sameViewers(prev, next) ? prev : next));
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

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');

      const url = `${resolvePresenceUrl()}/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        setStatus('connected');
        // Fire one heartbeat immediately, then on the 15s cadence.
        const beat = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat' }));
          }
        };
        beat();
        heartbeatTimer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          // Non-JSON frame — ignore, presence only speaks JSON.
          return;
        }
        const message = PresenceViewersMessageSchema.safeParse(parsed);
        if (!message.success) return;
        // A parsed `viewers` broadcast proves the connection is truly
        // established — the server rejects a bad token *before* sending
        // any frame. Resetting the backoff here (rather than on `onopen`,
        // which fires for the doomed handshake too) stops a
        // handshake-then-reject case, e.g. an expired token, from
        // pinning the reconnect delay at its 1s floor forever.
        reconnectAttempts = 0;
        const { dueAt } = ingestBroadcast(flicker, message.data.viewers, Date.now());
        project(dueAt);
      };

      ws.onerror = () => {
        // `onclose` always follows `onerror`; handle teardown there.
      };

      ws.onclose = (event) => {
        if (disposed) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        // The row hides whenever the connection is down (`status: 'error'`).
        setStatus('error');
        // A revoked read grant (4403) or a stale token (4401) would just
        // be rejected again on an immediate retry — stop reconnecting.
        // A fresh token from `usePresenceToken`'s refetch re-runs this
        // effect; a restored grant is picked up on that reconnect.
        if (event.code === PRESENCE_CLOSE_NO_ACCESS || event.code === PRESENCE_CLOSE_INVALID_TOKEN) return;
        // Otherwise reconnect with capped exponential backoff.
        const delay = Math.min(PRESENCE_RECONNECT_BASE_MS * 2 ** reconnectAttempts, PRESENCE_RECONNECT_MAX_MS);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (admissionTimer) clearTimeout(admissionTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
  }, [pageId, token, selfUserId]);

  // Clear the rendered list when navigating away from a page so a
  // stale stack never bleeds across page views.
  useEffect(() => {
    flickerRef.current = createAntiFlickerState();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewers([]);
  }, [pageId]);

  return { viewers, selfUserId, status };
}
