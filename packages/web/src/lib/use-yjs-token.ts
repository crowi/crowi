'use client';

import { useQuery } from '@tanstack/react-query';
import type { WsTokenResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

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
  return useQuery<WsTokenResponse>({
    queryKey: ['yjsToken', pageId],
    queryFn: async () => {
      if (!pageId) throw new Error('pageId is required for useYjsToken');
      const result = await apiClient.pageCollab.getYjsToken({ params: { id: pageId } });
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to issue wsToken',
      });
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
