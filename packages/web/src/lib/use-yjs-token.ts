'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WsTokenResponse } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';
import { subscribeTokenRefreshed } from './token-refresh-notifier';

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
 *   - on a silent access-token refresh, but ONLY when the cached wsToken is
 *     actually (near-)expired (the `subscribeTokenRefreshed` effect below).
 *
 * Focus-triggered refetch is disabled for the same provider-rebuild reason.
 */
export function useYjsToken(pageId: string | null | undefined) {
  const queryClient = useQueryClient();

  // §4 / H7 — when a silent access-token refresh succeeds, re-fetch the
  // wsToken ONLY when the cached wsToken is actually expired (or about to
  // be). The previous version invalidated unconditionally on every silent
  // refresh, which tore down + rebuilt the Y.Doc + HocuspocusProvider even
  // for a perfectly healthy, mid-edit session whose wsToken was still
  // valid (the wsToken is independent of the access token). That churned
  // healthy sessions; the seam is meant to ENABLE recovery, not cause it.
  //
  // A wsToken that expired around the same time as the access token leaves
  // the provider in `auth-failed`; only THEN do we hand it a fresh token
  // here (the dynamic `refetchInterval` already covers proactive,
  // not-yet-expired refresh). When the cached token is still well within
  // its TTL we leave it — the live provider keeps running untouched.
  useEffect(() => {
    if (!pageId) return;
    return subscribeTokenRefreshed(() => {
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
      const response = await apiClientV2.pages[':id']['yjs-token'].$get({ param: { id: pageId } });
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
