/**
 * Tiny synchronous helper around the JWT pair the web client holds
 * between login and logout. Keeps the localStorage and cookie writes
 * in lock-step so:
 *
 *   - JS-driven API calls read the access token from localStorage and
 *     pass it via `Authorization: Bearer ...`. `apiFetch` (`api-client.ts`),
 *     `useAddAttachment` (`use-attachments.ts`), and `uploadAttachment`
 *     (`upload-placeholder.ts`) all fail closed instead of sending a
 *     headerless request when this is unavailable (feature-auth-cookie-
 *     fallback-scope).
 *   - `<img src="/api/attachments/…">` requests (which the browser
 *     builds with no JS hook and therefore no Authorization header)
 *     fall back to the `crowi.accessToken` cookie. As of
 *     feature-auth-cookie-fallback-scope, the api-side `createJwtAuth`
 *     boundary (used by everything except attachment delivery — admin,
 *     `/pages/*`, `/auth/me`, plugin `auth: 'user'` routes, etc.) is
 *     HEADER-ONLY: it never reads this cookie at all. Only the dedicated
 *     `createAttachmentAuth` boundary reads it, and only for GET/HEAD on
 *     the three headerless delivery routes (`/attachments/:id`,
 *     `/attachments/:id/original`, `/attachments/by-key/*`) — exactly the
 *     `<img src>` / direct-navigation shape this cookie exists for. Every
 *     other attachment route (upload / meta / delete / add) requires the
 *     header, same as everything else.
 *
 * The cookie path is `/`, SameSite=Lax, no Secure (dev), no HttpOnly
 * (so `clearAccessToken()` from JS can wipe it on logout). For
 * production this is acceptable because the cookie only authenticates
 * read-only image URLs same-origin, and the underlying token is
 * already exposed in localStorage.
 */

import { notifyAuthTokenChange } from './auth-token-store';

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
  // Same-tab notify: the reactive token-presence store re-evaluates `useAuth`'s
  // `enabled` gate (false → true on login / inline reauth → auto-fetch /auth/me).
  notifyAuthTokenChange();
}

/**
 * Wipe all auth state — logout, 401, or unrecoverable error.
 */
export function clearTokens(): void {
  if (!isBrowser()) return;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
  // Same-tab notify: flips `useAuth`'s `enabled` gate to false so the query
  // goes idle and the layout redirect guard fires (logout / 401 / reauth fail).
  notifyAuthTokenChange();
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
