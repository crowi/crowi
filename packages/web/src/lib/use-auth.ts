'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import { clearTokens, getRefreshToken } from './auth-token';
import { useHasAccessToken } from './auth-token-store';
import { getConnectionErrorHandlers } from './connection-error-ref';
import { isNetworkError, isServerErrorStatus } from './is-network-error';

interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  image?: string;
  status: number;
  admin?: boolean;
  createdAt: string;
}

interface MeResponse {
  user: User;
}

/**
 * Query-key factory for the auth resource. The `['auth']` root never collides
 * with admin's `['admin','auth']` (`use-admin-auth-settings.ts`).
 */
export const authKeys = {
  all: ['auth'] as const,
  me: () => [...authKeys.all, 'me'] as const,
} as const;

/**
 * queryFn for `['auth','me']`. Runs OUTSIDE the React tree (no hooks), so the
 * connection handlers come from the module-level ref
 * (`connection-error-ref.ts`) that `ConnectionErrorBridge` keeps pointed at the
 * live `ConnectionProvider`.
 *
 * Returns the WHOLE `{ user }` body (not the bare `data.user`) so the query's
 * `data === { user }` and `useAuth().user = data?.user`. Status policy:
 *   - 200 → `setConnected()`, return body
 *   - 5xx → `setServerError()`, throw WITHOUT clearing tokens (transient: the
 *     error reducer retains the previous `data`, and `isAuthenticated=hasToken`
 *     stays true, so the authed header doesn't drop to "logged out")
 *   - network → `setNetworkError()`, throw without clearing tokens
 *   - 401 → `clearTokens()` (presence → false → redirect guard fires), throw.
 *     `retry: false` keeps this from racing the api-client refresh interceptor
 *     that already handled the 401.
 *
 * Raw `.json()` parse is intentional until P0-2 introduces `parseApiResponse`;
 * kept thin so it can be swapped later.
 */
async function fetchMe(): Promise<MeResponse> {
  const handlers = getConnectionErrorHandlers();

  let res: Awaited<ReturnType<typeof apiClientV2.auth.me.$get>>;
  try {
    res = await apiClientV2.auth.me.$get();
  } catch (error) {
    // Connection outage / timeout: keep tokens so the optimistic authed UI
    // survives a transient blip; surface the connection banner.
    if (isNetworkError(error)) handlers?.setNetworkError();
    throw error;
  }

  if (res.ok) {
    const data = await res.json();
    handlers?.setConnected();
    return data;
  }

  if (isServerErrorStatus(res.status)) {
    handlers?.setServerError(`サーバーエラーが発生しました (${res.status})`);
    throw new Error(`Server error (${res.status})`);
  }

  // 401 / auth failure — drop tokens. The reactive store notify flips
  // `hasToken` to false so `isAuthenticated`/`user` go false/null at once.
  clearTokens();
  throw new Error(`Authentication failed (${res.status})`);
}

/**
 * Thin wrapper over the `['auth','me']` React Query singleton. Every consumer
 * (15+ mount sites) shares one in-flight `/auth/me` and one cache entry, so
 * there is no duplicate fetch and no layout/child mismatch.
 *
 * `hasToken` (reactive access-token presence) is the SINGLE authority for "is
 * the client authenticated"; `isAuthenticated` / `user` are gated by it so a
 * 401 that retains stale `data` can never read back as authenticated, and a
 * transient 5xx that keeps the token stays authed. See the spec truth table.
 */
export function useAuth() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Subscribe to token presence FIRST and unconditionally (Rules of Hooks).
  // Calling it behind `&&` would short-circuit under SSR and make the hook
  // call conditional.
  const hasToken = useHasAccessToken();

  const query = useQuery({
    queryKey: authKeys.me(),
    queryFn: fetchMe,
    enabled: hasToken,
    // No auto-refetch on focus / remount / reconnect — kills loading flicker.
    // Recovery is driven by the reactive `enabled` flip and AuthSync.
    staleTime: Infinity,
    gcTime: Infinity,
    // 401 is handled by the api-client refresh interceptor; retrying here races it.
    retry: false,
    // No `placeholderData` on purpose: on a stable key a 5xx produces
    // `status:'error'` (not `pending`) with `data` retained, so placeholderData
    // is inert. 5xx resilience comes from `hasToken` + the error reducer.
  });

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    try {
      await apiClientV2.auth.logout.$post({ json: refreshToken ? { refreshToken } : {} });
    } catch {
      // Non-fatal — local cleanup happens regardless.
    }
    clearTokens(); // reactive notify → `enabled` false
    queryClient.clear(); // wipe ALL cache so the next user can't see the previous user's pages/notifications
    router.push('/login');
  }, [router, queryClient]);

  const refetch = useCallback(() => queryClient.refetchQueries({ queryKey: authKeys.me() }), [queryClient]);

  const data = query.data;
  return {
    // `hasToken` gate is load-bearing: never read RETAINED stale `data` once
    // the token is gone (401 / logout / cross-tab logout).
    user: hasToken ? (data?.user ?? null) : null,
    // v5 `isLoading = isPending && isFetching`; `enabled:false` ⇒ idle ⇒ false.
    isLoading: query.isLoading,
    isAuthenticated: hasToken,
    logout,
    refetch,
  };
}
