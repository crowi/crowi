import { createClient } from '@crowi/api-contract';
import { clearTokens, storeTokens } from './auth-token';
import { API_TIMEOUT_MS, fetchWithTimeout } from './fetch-timeout';
import { env } from './runtime-env';
import { notifyTokenRefreshed } from './token-refresh-notifier';

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
  // Strip trailing slash(es) so `apiBaseUrl()` never yields `…//api`
  // (a value like `https://api.example.com/` would otherwise double the slash).
  return (env('NEXT_PUBLIC_API_URL') || '').replace(/\/+$/, '');
}

/** Runtime-resolved `<origin>/api` base. Read at call time (see {@link apiOrigin}). */
export function apiBaseUrl(): string {
  return `${apiOrigin()}/api`;
}

/**
 * Resolve an API-relative absolute path (e.g. the `rendererStylesheets`
 * manifest entries from `GET /api/app/info`, already including the
 * `/api` prefix — see `AppInfoResponseSchema`) to a browser-usable URL.
 * Reads {@link apiOrigin} at call time, same as `apiFetch` below — an
 * empty origin (same-origin deployment) returns `path` unchanged
 * (relative), so a `<link href>` built from this helper works the same
 * whether the API is same-origin or cross-origin. Not just for fetch
 * bodies: `RendererStylesheets` (`packages/web/src/components/
 * renderer-stylesheets.tsx`) uses this for `<link rel="stylesheet">` href
 * values, which is why this is a standalone export rather than folded
 * into `apiFetch`.
 */
export function resolveApiUrl(path: string): string {
  const origin = apiOrigin();
  return origin ? `${origin}${path}` : path;
}

let refreshPromise: Promise<string | null> | null = null;

/**
 * Return a single in-flight refresh promise so concurrent 401s coalesce
 * onto one `/auth/refresh` call. Capturing the local `promise` reference
 * before reading `refreshPromise` avoids the TOCTOU race where `.finally`
 * nulls out `refreshPromise` between the `if (!refreshPromise)` check and
 * the `await`.
 *
 * Exported (feature-auth-cookie-fallback-scope) so `useAddAttachment`
 * (`use-attachments.ts`) and `uploadAttachment` (`upload-placeholder.ts`) —
 * both hand-rolled `fetch`/`XMLHttpRequest` calls that bypass `apiFetch` for
 * upload-progress reasons — can recover a token through the SAME
 * single-flight refresh `apiFetch` uses below, rather than re-implementing
 * it or sending their own request headerless while a token is missing.
 */
export function acquireRefreshedToken(): Promise<string | null> {
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
      `${apiBaseUrl()}/auth/refresh`,
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
      // §4 — let the realtime layer (collab / presence token hooks)
      // re-fetch their short-lived tokens now that credentials are
      // fresh, instead of waiting for their own ~5-min interval. This is
      // the single point a silent refresh becomes observable to them.
      notifyTokenRefreshed();
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
 * RFC-0006 Phase 4 Batch 9 / Phase 6 — the legacy ts-rest `apiClient`
 * (`initClient(apiContract)`) is gone. The `apiContract` aggregator was
 * emptied in Batch 9 when the 9 admin sub-contracts moved to Hono; Phase 6
 * then dropped the framework package itself. All resources now go through
 * the `apiClient` below (built by `createClient`, see `@crowi/api-contract`'s
 * `CrowiApiClient`).
 */

/**
 * RFC-0006 Phase 3 — typed `createClient` client for Hono-served resources.
 *
 * Wraps the global `fetch` with the same access-token / refresh-token dance
 * the legacy ts-rest client had, so every call site now goes through
 * `apiClient.<resource>.<endpoint>.$get(...)` etc.
 */
const REFRESH_PATH = '/auth/refresh';

/**
 * feature-auth-cookie-fallback-scope AC-3 — api paths a FULLY logged-out
 * browser (no access token AND no refresh token) may legitimately reach:
 * the pre-login `(public)/*` pages (login, register, installer, invite
 * accept, password reset, activation, email-change confirmation) plus the
 * `/app/info` bootstrap call and the public OAuth authorization-server
 * endpoints. Every other path is "protected" — `apiFetch` must not send it
 * headerless once both tokens are gone; see the guard below. Kept in exact
 * lock-step with each route's own `path:` (`packages/api-contract/src/
 * contracts/{token-auth,password-reset,activation,email-change,invite-accept,
 * installer,app,oauth}.ts`) — the api itself is the source of truth for
 * which routes install `createJwtAuth`, so this list is not re-derived at
 * request time, only kept aligned with it. Every entry here is a bare
 * pathname with no trailing wildcard — see `isPublicPath` below for why
 * membership is an EXACT match, never a substring/prefix one: `/oauth/device`
 * (public, `deviceInfoRoute`) and `/oauth/device/verify` (protected,
 * `deviceVerifyRoute` — web-session-only device approval) share a path
 * prefix but must resolve to opposite answers.
 */
const PUBLIC_PATHS = [
  '/auth/login',
  '/auth/register',
  REFRESH_PATH,
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/activate',
  '/auth/confirm-email-change',
  '/invite/accept',
  '/installer',
  '/installer/createAdmin',
  '/app/info',
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/device',
  '/oauth/device/authorize',
  '/oauth/client-info',
  '/.well-known/oauth-authorization-server',
] as const;

/**
 * Normalises a bare relative path (same-origin, `resolveApiUrl` returns it
 * unchanged) or an absolute cross-origin URL (`NEXT_PUBLIC_API_URL` set) to
 * its `pathname` — the shared basis for every EXACT-match check below
 * ({@link isPublicPath}, the refresh-endpoint check in `apiFetch`). Never
 * compare `urlString` itself with `.includes()`/`.startsWith()`: a query
 * string or unrelated path segment (e.g. `/api/pages?path=/auth/refresh`)
 * can otherwise falsely match.
 */
const toPathname = (urlString: string): string => {
  try {
    return new URL(urlString, 'http://localhost').pathname;
  } catch {
    return urlString;
  }
};

/**
 * EXACT pathname match against {@link PUBLIC_PATHS} — never a substring/
 * prefix check. Checked against the entry both bare and `/api`-prefixed
 * because `apiClient` is built with base `/api` (so real request paths are
 * `/api/auth/login` etc.) while {@link PUBLIC_PATHS} itself is written
 * without that prefix for direct correspondence with each contract's own
 * `path:`.
 */
/**
 * Both spellings are materialised once at module init rather than rebuilt per
 * call: this runs on every request made while fully logged out, which is
 * exactly the pre-login page-load burst.
 */
const PUBLIC_PATH_SET = new Set(PUBLIC_PATHS.flatMap((path) => [path, `/api${path}`]));

/** Takes an already-extracted pathname so callers that have one don't re-parse the URL. */
const isPublicPath = (pathname: string): boolean => PUBLIC_PATH_SET.has(pathname);

/**
 * feature-auth-cookie-fallback-scope — the api's `createJwtAuth` default is
 * now header-only (cookie fallback is scoped to headerless attachment
 * delivery only). Synthesized locally, without a network round-trip, for
 * `apiFetch`'s "token missing and unrecoverable" short-circuit below — same
 * `AUTHENTICATION_REQUIRED` shape a real 401 from the api would carry, so
 * every existing `errors: {401: ...}` / `silent: {statuses: [401], ...}`
 * caller (`unwrapResult`, `use-*` hooks) handles it exactly like a wire 401.
 */
function authRequiredResponse(): Response {
  return new Response(JSON.stringify({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Exported (feature-auth-cookie-fallback-scope) for a direct unit test of
 * the token-missing / refresh / headerless-send-avoidance branches
 * (`api-client.test.ts`) — `apiClient` itself only exposes the typed
 * resource tree, not this wrapper.
 */
export const apiFetch: typeof fetch = async (input, init) => {
  // `apiClient` is created with a RELATIVE base (`/api`). Resolve
  // through `resolveApiUrl` here — at call time, after the root layout's
  // inline env script has set `window.__ENV` — so a cross-origin
  // `NEXT_PUBLIC_API_URL` takes effect with no rebuild. An empty origin
  // leaves URLs relative (same-origin image).
  const target = typeof input === 'string' && input.startsWith('/') ? resolveApiUrl(input) : input;

  const urlString = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
  // EXACT pathname match, same as `isPublicPath` — a substring check here
  // would let e.g. `/api/pages?path=/auth/refresh` masquerade as the
  // refresh endpoint and skip the token-missing send-avoidance guard below.
  const refreshPathname = toPathname(urlString);
  const isRefreshEndpoint = refreshPathname === REFRESH_PATH || refreshPathname === `/api${REFRESH_PATH}`;

  const headers = new Headers(init?.headers);
  // A caller-supplied `Authorization` header (e.g. a direct `apiFetch(url, {
  // headers: { Authorization: ... } })` call) is an explicit credential the
  // caller already resolved — never second-guess it by attempting a
  // localStorage-driven refresh/short-circuit below, which could otherwise
  // suppress a valid explicit credential just because `refreshAccessToken()`
  // (a DIFFERENT, ambient credential) failed.
  const hasExplicitAuthHeader = headers.has('authorization');
  let accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  // No access token on hand. Two sub-cases, both handled without ever
  // letting a headerless request depend on the (now attachment-delivery-only)
  // `crowi.accessToken` cookie fallback:
  //   - a refresh token IS present — a session exists but the access token
  //     isn't loaded (`storeTokens` / `clearTokens` in auth-token.ts normally
  //     write/clear both together, so this is an edge case). Recover the
  //     access token through the existing single-flight refresh before
  //     sending anything.
  //   - no refresh token either — nothing to recover. Public pre-login flows
  //     (`/auth/login`, `/installer`, …) always reach here with BOTH tokens
  //     absent and must keep working headerless; every other ("protected")
  //     path short-circuits locally instead of going out headerless.
  if (!accessToken && !hasExplicitAuthHeader && typeof window !== 'undefined' && !isRefreshEndpoint) {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      accessToken = await acquireRefreshedToken();
      if (!accessToken) {
        // `refreshAccessToken()` already ran the existing auth-invalidation
        // path (`clearTokens` + the `auth:session-expired` event consumed by
        // `(auth)/layout.tsx` / `SessionReauthProvider`). Don't send a
        // headerless request — return the same 401 shape a real one would.
        return authRequiredResponse();
      }
    } else if (!isPublicPath(refreshPathname)) {
      // No refresh token either — there is nothing left to recover, and
      // this is not one of the pre-login public flows that must legitimately
      // work while fully logged out. Sending this request headerless would
      // only ever succeed via the (now attachment-delivery-only)
      // `crowi.accessToken` cookie fallback, or fail with an ordinary 401 —
      // short-circuit locally with the same shape instead of depending on
      // either.
      return authRequiredResponse();
    }
  }

  if (accessToken && !hasExplicitAuthHeader) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  let response = await fetchWithTimeout(target, { ...init, headers }, API_TIMEOUT_MS);

  // Don't try to refresh when the failed call *is* the refresh endpoint —
  // doing so would recurse once `/auth/refresh` lands on Hono (Phase 4). Also
  // never retry when the caller supplied an explicit `Authorization` header
  // (feature-auth-cookie-fallback-scope): that credential is not ours to
  // second-guess, and retrying with a refreshed AMBIENT web-session token
  // would silently swap the caller's explicit principal for a different one
  // on a 401 — see the `hasExplicitAuthHeader` comment above.
  if (response.status === 401 && !isRefreshEndpoint && !hasExplicitAuthHeader && typeof window !== 'undefined') {
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

// Relative base; `apiFetch` prepends the runtime origin at call time so the
// cross-origin `NEXT_PUBLIC_API_URL` is honored without freezing it at module
// load (see `apiOrigin`).
export const apiClient = createClient('/api', {
  fetch: apiFetch,
});
