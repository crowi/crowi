/**
 * Build a `/login?continue=…` URL that returns the user to their
 * current page after a successful login. Skips the `continue` param
 * when the current path is `/` or already on `/login` (avoids a
 * login→login bounce).
 */
export function buildLoginRedirectUrl(currentPath: string): string {
  if (!currentPath || currentPath === '/' || currentPath.startsWith('/login')) {
    return '/login';
  }
  return `/login?continue=${encodeURIComponent(currentPath)}`;
}

/**
 * Sanitize a `continue` value pulled out of the URL. Only same-origin
 * paths are allowed — anything else falls back to `/` so a crafted
 * link like `/login?continue=https://evil.example/` can't be used to
 * bounce a logged-in user to an attacker-controlled site (the classic
 * post-login open-redirect vector).
 *
 * Rules:
 * - Must start with a single `/`.
 * - Must NOT start with `//` (protocol-relative — `//evil.example/`
 *   would otherwise navigate cross-origin).
 * - Must NOT start with `/\` — some browsers normalize the backslash
 *   to `//` before navigation.
 */
export function safeContinueUrl(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * The default post-login / post-confirmation landing path when no
 * explicit `continue` was supplied — the signed-in user's own user page
 * (`/user/<username>`), which is a friendlier first screen than the
 * portal root. Falls back to `/` if the username is somehow empty.
 */
export function defaultLandingPath(username: string | null | undefined): string {
  if (!username) return '/';
  return `/user/${username}`;
}
