import { initClient } from '@ts-rest/core';
import { apiContract } from '@crowi/api-contract';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${API_BASE_URL}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem('accessToken', data.accessToken);
      if (data.refreshToken) {
        localStorage.setItem('refreshToken', data.refreshToken);
      }
      return data.accessToken;
    } else {
      // Refresh failed - clear tokens and redirect to login
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      window.location.href = '/login';
      return null;
    }
  } catch {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
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
    let response = await fetch(path, {
      method,
      headers: requestHeaders,
      body: body as BodyInit | undefined,
    });

    // If 401 and we have a refresh token, try to refresh
    if (response.status === 401 && typeof window !== 'undefined') {
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) {
        // Prevent multiple simultaneous refresh requests
        if (!isRefreshing) {
          isRefreshing = true;
          refreshPromise = refreshAccessToken().finally(() => {
            isRefreshing = false;
            refreshPromise = null;
          });
        }

        // Wait for refresh to complete
        const newAccessToken = await refreshPromise;

        if (newAccessToken) {
          // Retry the original request with new token
          requestHeaders['Authorization'] = `Bearer ${newAccessToken}`;
          response = await fetch(path, {
            method,
            headers: requestHeaders,
            body: body as BodyInit | undefined,
          });
        }
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
