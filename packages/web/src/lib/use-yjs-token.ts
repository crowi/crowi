'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WsTokenResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import type { CollabStatus } from './use-collab-document';
import { subscribeTokenRefreshed } from './token-refresh-notifier';

/**
 * Options for `useYjsToken`. `getConnectionStatus` lets the caller
 * (`useCollabSession`) tell the hook whether the live collab WebSocket is
 * currently CONNECTED — see the D1a note on the notifier-driven refetch.
 */
export interface UseYjsTokenOptions {
  getConnectionStatus?: () => CollabStatus;
}

/**
 * Fetch the short-lived wsToken JWT that the Hocuspocus client presents
 * on connect.
 *
 * Lifecycle (D1, round 2): the wsToken authenticates the (re)connect
 * HANDSHAKE only — once the WebSocket is established it stays open across
 * the whole edit session even after the token's `exp` passes. So we do NOT
 * proactively refetch on a timer: a swap tears down + rebuilds the
 * `HocuspocusProvider` (4.x has no runtime token-replace API), which resets
 * `hasEverSynced` and remounts CodeMirror mid-edit (cursor / scroll / IME /
 * undo lost). The pre-fix ~4.5-min `refetchInterval` did exactly that every
 * token TTL window, defeating the H5 sticky mount gate.
 *
 * A fresh token is fetched ONLY when (re)connecting:
 *   - on mount (the initial connect), via the query itself;
 *   - on `auth-failed` (a reconnect with an expired/rejected token),
 *     nudged by the bounded backoff in `useCollabSession`;
 *   - on a silent access-token refresh, but ONLY when the connection is NOT
 *     currently established AND the cached wsToken is actually (near-)expired
 *     (the `subscribeTokenRefreshed` effect below).
 *
 * Focus-triggered refetch is disabled for the same provider-rebuild reason.
 */
export function useYjsToken(pageId: string | null | undefined, options?: UseYjsTokenOptions) {
  const queryClient = useQueryClient();

  // Keep the connection-status getter in a ref so the subscriber effect
  // doesn't re-subscribe when the caller passes a fresh closure each render.
  const getConnectionStatusRef = useRef(options?.getConnectionStatus);
  useEffect(() => {
    getConnectionStatusRef.current = options?.getConnectionStatus;
  }, [options?.getConnectionStatus]);

  // §4 / D1a — when a silent access-token refresh succeeds, re-fetch the
  // wsToken ONLY when the live collab connection actually needs a fresh
  // token to (re)connect.
  //
  // The wsToken authenticates the HANDSHAKE only; once the WebSocket is
  // ESTABLISHED it stays authenticated for its whole life regardless of the
  // token's `exp`. So while we are `connected`, a lapsed wsToken TTL is
  // irrelevant — refetching it would only tear down + rebuild the provider
  // (new Y.Doc / yText → editor remount mid-edit), the exact churn D1 exists
  // to prevent. We therefore gate the refetch on "not currently connected":
  //   - `connected`  → never refetch (D1a), even past the token TTL;
  //   - otherwise (`connecting` / `disconnected` / `auth-failed`, or no
  //     status getter wired) → refetch, but only when the cached wsToken is
  //     actually expired / within ~30s of expiry, so a still-valid token
  //     isn't needlessly swapped.
  useEffect(() => {
    if (!pageId) return;
    return subscribeTokenRefreshed(() => {
      // D1a — a healthy, established connection does not care that the
      // wsToken's TTL lapsed; leave the live provider untouched.
      if (getConnectionStatusRef.current?.() === 'connected') return;
      const cached = queryClient.getQueryData<WsTokenResponse>(['yjsToken', pageId]);
      // No cached token yet, or it is within ~30s of expiry / already
      // expired → refetch. A comfortably-valid token is left in place so
      // the provider isn't rebuilt mid-edit.
      const expiresInMs = cached ? Date.parse(cached.expiresAt) - Date.now() : -1;
      if (expiresInMs > 30_000) return;
      void queryClient.invalidateQueries({ queryKey: ['yjsToken', pageId], refetchType: 'active' });
    });
  }, [pageId, queryClient]);

  return useQuery({
    queryKey: ['yjsToken', pageId],
    queryFn: async (): Promise<WsTokenResponse> => {
      if (!pageId) throw new Error('pageId is required for useYjsToken');
      const response = await apiClient.pages[':id']['yjs-token'].$get({ param: { id: pageId } });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error
            ? String(body.error.message)
            : 'Failed to issue wsToken';
        throw new Error(message);
      }
      return response.json();
    },
    enabled: Boolean(pageId),
    // D1 — NO proactive `refetchInterval`. An established connection
    // persists past the token's TTL; refetching mid-edit would rebuild the
    // provider and remount the editor. Re-tokenisation happens only on a
    // (re)connect path (auth-failed backoff / silent-refresh-when-expired).
    //
    // Avoid focus-triggered rebuilds of the live HocuspocusProvider too
    // (default `refetchOnWindowFocus: true` would otherwise refresh the
    // token on any tab focus past `staleTime`).
    refetchOnWindowFocus: false,
    // The token is long-lived from the query's perspective (we never want a
    // staleness-driven background refetch to rebuild the provider). Recovery
    // refetches go through explicit `invalidateQueries` / `refetch`.
    staleTime: Infinity,
    retry: 3,
  });
}
