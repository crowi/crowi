import { createClient } from '@crowi/api-contract';
import { clearTokens, storeTokens } from './auth-token';
import { API_TIMEOUT_MS, fetchWithTimeout } from './fetch-timeout';
import { env } from './runtime-env';

/**
 * Runtime-resolved browser API origin. `''` = same-origin (relative URLs);
 * a non-empty value (e.g. `https://api.example.com`) points the browser at a
 * cross-origin api host.
 *
 * MUST be read at call time, NOT captured at module scope. The root layout
 * injects `window.__ENV` from the container's runtime env; a module-level
 * `const API_BASE_URL = env(...)` would freeze before the value is read and
 * send every request same-origin regardless. Reading inside each request
 * returns the correct value, covering dev (`pnpm dev`) and Vercel too.
 */
export function apiOrigin(): string {
  // Strip trailing slash(es) so `apiV2BaseUrl()` never yields `…//api/v2`
  // (a value like `https://api.example.com/` would otherwise double the slash).
  return (env('NEXT_PUBLIC_API_URL') || '').replace(/\/+$/, '');
}

/** Runtime-resolved `<origin>/api/v2` base. Read at call time (see {@link apiOrigin}). */
export function apiV2BaseUrl(): string {
  return `${apiOrigin()}/api/v2`;
}

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
  if (!refreshToken) return null;

  try {
    const response = await fetchWithTimeout(
      `${apiV2BaseUrl()}/auth/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      },
      API_TIMEOUT_MS,
    );

    if (response.ok) {
      const data = await response.json();
      storeTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken }, data.expiresIn);
      return data.accessToken;
    }
    clearTokens();
    // `(auth)/layout.tsx` listens for this and redirects to /login.
    window.dispatchEvent(new CustomEvent('auth:session-expired'));
    return null;
  } catch {
    clearTokens();
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
  // `apiClientV2` is created with a RELATIVE base (`/api/v2`). Prepend the
  // runtime origin here — at call time, after `<PublicEnvScript>` has set
  // `window.__ENV` — so a cross-origin `NEXT_PUBLIC_API_URL` takes effect with
  // no rebuild. An empty origin leaves URLs relative (same-origin image).
  const origin = apiOrigin();
  const target = origin && typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;

  const headers = new Headers(init?.headers);
  const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  if (accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  let response = await fetchWithTimeout(target, { ...init, headers }, API_TIMEOUT_MS);

  // Don't try to refresh when the failed call *is* the refresh endpoint —
  // doing so would recurse once `/auth/refresh` lands on Hono (Phase 4).
  const urlString = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
  const isRefreshEndpoint = urlString.includes(REFRESH_PATH);

  if (response.status === 401 && !isRefreshEndpoint && typeof window !== 'undefined') {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      const newAccessToken = await acquireRefreshedToken();
      if (newAccessToken) {
        headers.set('authorization', `Bearer ${newAccessToken}`);
        // Fresh timeout for the retried request (a new AbortController per
        // attempt so the first attempt's timer can't cancel the retry).
        response = await fetchWithTimeout(target, { ...init, headers }, API_TIMEOUT_MS);
      }
    }
  }

  return response;
};

// Relative base; `apiV2Fetch` prepends the runtime origin at call time so the
// cross-origin `NEXT_PUBLIC_API_URL` is honored without freezing it at module
// load (see `apiOrigin`).
export const apiClientV2 = createClient('/api/v2', {
  fetch: apiV2Fetch,
});
