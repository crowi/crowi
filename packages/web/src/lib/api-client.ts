import { initClient } from '@ts-rest/core';
import { apiContract } from '@crowi/api-contract';
import { clearTokens, storeTokens } from './auth-token';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

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
        // Prevent multiple simultaneous refresh requests
        if (!isRefreshing) {
          console.log('[api-client] Starting refresh (not already refreshing)');
          isRefreshing = true;
          refreshPromise = refreshAccessToken().finally(() => {
            isRefreshing = false;
            refreshPromise = null;
          });
        } else {
          console.log('[api-client] Already refreshing, waiting for existing promise');
        }

        // Wait for refresh to complete
        const newAccessToken = await refreshPromise;
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
