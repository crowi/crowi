/**
 * Tiny synchronous helper around the JWT pair the web client holds
 * between login and logout. Keeps the localStorage and cookie writes
 * in lock-step so:
 *
 *   - JS-driven API calls read the access token from localStorage and
 *     pass it via `Authorization: Bearer ...`.
 *   - `<img src="/api/v2/attachments/…">` requests (which the browser
 *     builds with no JS hook and therefore no Authorization header)
 *     fall back to the `crowi.accessToken` cookie. The api-side
 *     `jwtAuth` middleware reads from cookie when the header is absent.
 *
 * The cookie path is `/`, SameSite=Lax, no Secure (dev), no HttpOnly
 * (so `clearAccessToken()` from JS can wipe it on logout). For
 * production this is acceptable because the cookie only authenticates
 * read-only image URLs same-origin, and the underlying token is
 * already exposed in localStorage.
 */

const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';
const COOKIE_NAME = 'crowi.accessToken';

const isBrowser = (): boolean => typeof window !== 'undefined';

/**
 * Persist a freshly-minted access + refresh pair on login / refresh.
 * `accessTokenTtlSeconds` is the cookie max-age — callers should pass
 * the `expiresIn` from the `/auth/login` / `/auth/refresh` response so
 * the cookie expires together with the JWT it carries (`<img>` requests
 * cannot re-authenticate via the refresh interceptor). The 1h default
 * matches the api's default `JWT_ACCESS_TOKEN_TTL_SECONDS`.
 */
export function storeTokens(tokens: { accessToken: string; refreshToken?: string }, accessTokenTtlSeconds: number = 60 * 60): void {
  if (!isBrowser()) return;
  localStorage.setItem(ACCESS_KEY, tokens.accessToken);
  if (tokens.refreshToken) localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(tokens.accessToken)}; path=/; max-age=${accessTokenTtlSeconds}; samesite=lax`;
}

/**
 * Wipe all auth state — logout, 401, or unrecoverable error.
 */
export function clearTokens(): void {
  if (!isBrowser()) return;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
}

/** Convenience read used by callers that only need the access token. */
export function getAccessToken(): string | null {
  if (!isBrowser()) return null;
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (!isBrowser()) return null;
  return localStorage.getItem(REFRESH_KEY);
}
