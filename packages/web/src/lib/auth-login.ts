'use client';

import { apiClientV2 } from './api-client';
import { storeTokens } from './auth-token';
import { errorMessage } from './error-message';
import { m } from '@paraglide/messages.js';

/**
 * Shared email/password login. Posts to `/auth/login`, and on success
 * persists the returned token pair via `storeTokens` (which also mirrors
 * the access token into the `crowi.accessToken` cookie and — because it
 * writes localStorage — fires a `storage` event other tabs observe).
 *
 * Used by both the public login form and the editor's inline
 * session-reauth modal so the two stay in lock-step (single source of
 * truth for the wire format + token persistence). The caller owns
 * navigation / UI state; this only returns a discriminated result.
 */
export type LoginResult = { ok: true; username: string } | { ok: false; message: string };

export async function loginWithPassword(email: string, password: string): Promise<LoginResult> {
  try {
    const response = await apiClientV2.auth.login.$post({
      json: { email, password },
    });

    if (response.status === 200) {
      const body = await response.json();
      storeTokens(body, body.expiresIn);
      // The login response already carries the signed-in user, so the
      // caller can compute its default landing path (`/user/<username>`)
      // without a follow-up `/me` round-trip.
      return { ok: true, username: body.user.username };
    }

    if (response.status === 401 || response.status === 403 || response.status === 503) {
      const body = await response.json();
      return { ok: false, message: errorMessage(body.error?.code, body.error?.message || m['auth.login.error']()) };
    }

    return { ok: false, message: m['auth.login.unexpected_error']() };
  } catch {
    return { ok: false, message: m['auth.common.server_error']() };
  }
}
