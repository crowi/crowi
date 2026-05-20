import { initClient } from '@ts-rest/core';
import { apiContract, createClient } from '@crowi/api-contract';
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

export const apiClient = initClient(apiContract, {
  baseUrl: `${API_BASE_URL}/api/v2`,
  baseHeaders: {},
  api: async ({ path, method, headers, body }) => {
    // Get access token from localStorage (client-side only)
    const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

    // Build headers object
    const requestHeaders: HeadersInit = {
      ...headers,
    };

    // Add Authorization header if token exists
    if (accessToken) {
      requestHeaders['Authorization'] = `Bearer ${accessToken}`;
    }

    // Make the fetch request
    console.log('[api-client] Request:', method, path);
    let response = await fetch(path, {
      method,
      headers: requestHeaders,
      body: body as BodyInit | undefined,
    });
    console.log('[api-client] Response status:', response.status);

    // If 401 and we have a refresh token, try to refresh
    if (response.status === 401 && typeof window !== 'undefined') {
      console.log('[api-client] Got 401, attempting token refresh...');
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) {
        const newAccessToken = await acquireRefreshedToken();
        console.log('[api-client] Refresh complete, hasNewToken:', !!newAccessToken);

        if (newAccessToken) {
          // Retry the original request with new token
          console.log('[api-client] Retrying request with new token');
          requestHeaders['Authorization'] = `Bearer ${newAccessToken}`;
          response = await fetch(path, {
            method,
            headers: requestHeaders,
            body: body as BodyInit | undefined,
          });
          console.log('[api-client] Retry response status:', response.status);
        }
      } else {
        console.log('[api-client] No refresh token available');
      }
    }

    // Parse response body based on content-type
    const contentType = response.headers.get('content-type');
    let responseBody;

    if (contentType?.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Return in the format ts-rest expects
    return {
      status: response.status,
      body: responseBody,
      headers: response.headers,
    };
  },
});

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
