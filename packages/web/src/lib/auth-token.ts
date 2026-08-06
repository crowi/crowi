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
 * As of feature-access-token-cookie-path-scope, the cookie is written with
 * `path=/api/attachments` (not `path=/`) — the common minimal subtree of the
 * three headerless delivery routes above and nothing else, so the browser
 * only attaches it to `<img src>` / direct-navigation requests against
 * attachment delivery, not to every same-origin request. SameSite=Lax, no
 * Secure (dev), no HttpOnly (so `clearTokens()` from JS can wipe it on
 * logout). For production this is acceptable because the cookie only
 * authenticates read-only image URLs same-origin, and the underlying token
 * is already exposed in localStorage.
 *
 * Before this change every deployed cookie carried `path=/`. A cookie's path
 * is part of its identity — a scoped `path=/api/attachments` delete does NOT
 * remove a pre-existing `path=/` cookie of the same name — so `storeTokens`
 * and `clearTokens` both also expire the legacy root-scoped cookie
 * unconditionally. Expiring an absent/already-expired cookie is a no-op, so
 * this cleanup needs no first-run flag and is safe to run on every call.
 */

import { notifyAuthTokenChange } from './auth-token-store';

const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';
const COOKIE_NAME = 'crowi.accessToken';

/**
 * The only path the mirror cookie is written to going forward. Sole source
 * for both the scoped `set` (`storeTokens`) and the scoped `delete`
 * (`clearTokens`) so the two can never drift apart — a set/delete path
 * mismatch means the browser treats them as different cookies and the
 * "delete" silently leaves the real one behind. Matches the three
 * headerless attachment delivery routes (`/attachments/:id`,
 * `/attachments/:id/original`, `/attachments/by-key/*`, mounted under `/api`
 * by the api's route prefix) and nothing outside that subtree.
 */
const ACCESS_TOKEN_COOKIE_PATH = '/api/attachments';

/** The `path=/` every cookie predating this change was written with. */
const LEGACY_ROOT_COOKIE_PATH = '/';

const isBrowser = (): boolean => typeof window !== 'undefined';

/** Write (or, with `maxAgeSeconds: 0`, expire) the mirror cookie at `path`. */
function writeAccessTokenCookie(path: string, encodedValue: string, maxAgeSeconds: number): void {
  document.cookie = `${COOKIE_NAME}=${encodedValue}; path=${path}; max-age=${maxAgeSeconds}; samesite=lax`;
}

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
  // Expire any pre-existing `path=/` cookie before writing the scoped one —
  // see the module doc comment on why this can't be conditional.
  writeAccessTokenCookie(LEGACY_ROOT_COOKIE_PATH, '', 0);
  writeAccessTokenCookie(ACCESS_TOKEN_COOKIE_PATH, encodeURIComponent(tokens.accessToken), accessTokenTtlSeconds);
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
  writeAccessTokenCookie(ACCESS_TOKEN_COOKIE_PATH, '', 0);
  // Also expire any pre-existing `path=/` cookie — see the module doc comment.
  writeAccessTokenCookie(LEGACY_ROOT_COOKIE_PATH, '', 0);
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
