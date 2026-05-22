import { createClient } from '@crowi/api-contract';
import { clearTokens, storeTokens } from './auth-token';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4301';

let refreshPromise: Promise<string | null> | null = null;

/**
 * Return a single in-flight refresh promise so concurrent 401s coalesce
 * onto one `/auth/refresh` call. Capturing the local `promise` reference
 * before reading `refreshPromise` avoids the TOCTOU race where `.finally`
 * nulls out `refreshPromise` between the `if (!refreshPromise)` check and
 * the `await`.
 */
function acquireRefreshedToken(): Promise<string | null> {
  let promise = refreshPromise;
  if (promise == null) {
    promise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    refreshPromise = promise;
  }
  return promise;
}

async function refreshAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  const refreshToken = localStorage.getItem('refreshToken');
  console.log('[api-client] refreshAccessToken called, hasRefreshToken:', !!refreshToken);
  if (!refreshToken) return null;

  try {
    console.log('[api-client] Attempting token refresh...');
    const response = await fetch(`${API_BASE_URL}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
    });

    console.log('[api-client] Refresh response status:', response.status);

    if (response.ok) {
      const data = await response.json();
      console.log('[api-client] Refresh successful, storing new tokens');
      storeTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return data.accessToken;
    } else {
      const errorBody = await response.text();
      console.log('[api-client] Refresh failed:', response.status, errorBody);
      clearTokens();
      // カスタムイベントを発行してReact側でナビゲーションを処理
      window.dispatchEvent(new CustomEvent('auth:session-expired'));
      return null;
    }
  } catch (err) {
    console.log('[api-client] Refresh error:', err);
    clearTokens();
    // カスタムイベントを発行してReact側でナビゲーションを処理
    window.dispatchEvent(new CustomEvent('auth:session-expired'));
    return null;
  }
}

/**
 * RFC-0006 Phase 4 Batch 9 / Phase 6 — the legacy `apiClient`
 * (ts-rest `initClient(apiContract)`) is gone. The `apiContract`
 * aggregator was emptied in Batch 9 when the 9 admin sub-contracts
 * moved to Hono; Phase 6 then dropped the framework package itself.
 * All resources now go through `apiClientV2` (`hc<AppType>`).
 */

/**
 * RFC-0006 Phase 3 — `hc<AppType>` client for Hono-served resources.
 *
 * Wraps the global `fetch` with the same access-token / refresh-token
 * dance as the ts-rest `apiClient` above so call sites can flip from
 * `apiClient.<resource>.<endpoint>` to `apiClientV2.<resource>.<endpoint>.
 * $get(...)` resource-by-resource as Phase 4 progresses. Phase 6
 * deletes the legacy `apiClient` once all resources have moved.
 */
const REFRESH_PATH = '/auth/refresh';

const apiV2Fetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  if (accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  let response = await fetch(input, { ...init, headers });

  // Don't try to refresh when the failed call *is* the refresh endpoint —
  // doing so would recurse once `/auth/refresh` lands on Hono (Phase 4).
  const urlString = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isRefreshEndpoint = urlString.includes(REFRESH_PATH);

  if (response.status === 401 && !isRefreshEndpoint && typeof window !== 'undefined') {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      const newAccessToken = await acquireRefreshedToken();
      if (newAccessToken) {
        headers.set('authorization', `Bearer ${newAccessToken}`);
        response = await fetch(input, { ...init, headers });
      }
    }
  }

  return response;
};

export const apiClientV2 = createClient(`${API_BASE_URL}/api/v2`, {
  fetch: apiV2Fetch,
});
