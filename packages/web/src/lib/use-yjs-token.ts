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
 * Lifecycle: server issues a 5-minute token. We refetch ~30s before
 * expiry so the client has time to recreate its `HocuspocusProvider`
 * (token swap requires destroy + recreate; the underlying
 * `HocuspocusProvider` 4.x has no runtime token-replace API). The
 * refetch interval is computed dynamically from `data.expiresAt` so
 * a server-side change in `WS_TOKEN_TTL` propagates automatically.
 *
 * Focus-triggered refetch is disabled: each refetch tears down + rebuilds
 * the HocuspocusProvider, which would interrupt an in-progress edit
 * session for no reason (the token is still valid). The dynamic interval
 * is the only refresh trigger.
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
    // Schedule the next round-trip 30s before `expiresAt`; floor at 30s
    // to avoid tight loops if the server hands us an already-near-expired
    // token (clock drift, etc).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const msUntilRefresh = Date.parse(data.expiresAt) - Date.now() - 30_000;
      return Math.max(30_000, msUntilRefresh);
    },
    // Avoid focus-triggered rebuilds of the live HocuspocusProvider while
    // the cached token is still valid (default `refetchOnWindowFocus: true`
    // would otherwise refresh the token on any tab focus past 30s).
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 3,
  });
}
