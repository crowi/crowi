'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useConnection } from './connection-context';
import { isReauthSuppressed } from './session-reauth-context';
import { subscribeTokenRefreshed } from './token-refresh-notifier';
import { authKeys } from './use-auth';

const ACCESS_KEY = 'accessToken';

/**
 * Decode the `userId` claim from an access-token JWT payload (no signature
 * verification — we only need to tell whether two tokens belong to the same
 * user). Returns null when the token is absent or unparseable, in which case
 * callers treat the change as "same user" (the safe default: never wipe the
 * cache on a token write we can't classify).
 */
function readUserId(token: string | null): string | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
    const claims = JSON.parse(json) as { userId?: unknown };
    return typeof claims.userId === 'string' ? claims.userId : null;
  } catch {
    return null;
  }
}

/**
 * Centralizes every auth-state listener in ONE mounted island so the thin
 * `useAuth` wrapper (rendered in 15+ places) does not register them N times.
 * Mounted once inside `<Providers>` (under `ConnectionProvider` +
 * `QueryClientProvider`). Renders nothing.
 *
 * Logout-class events ("the previous session is gone") all converge on
 * `queryClient.clear()` — UNLESS an inline-reauth editor is mounted
 * (`isReauthSuppressed()`), in which case the cache (incl. the unsaved Y.Doc's
 * collab/presence tokens) is preserved and an in-place reauth modal is opened
 * instead (the editor's `SessionReauthProvider` listens for
 * `auth:session-expired`).
 */
export function AuthSync(): null {
  const queryClient = useQueryClient();
  const { registerRetryCallback } = useConnection();

  // session-expired (refresh failed, dispatched by api-client.ts): wipe ALL
  // cache so a re-login as a different user can't read the previous user's
  // pages / notifications. The redirect itself is owned by the (auth)/(admin)
  // layout listeners. While an inline-reauth editor is mounted, do nothing —
  // the modal recovers in place and the cache (buffer tokens) must survive.
  useEffect(() => {
    const onSessionExpired = () => {
      if (isReauthSuppressed()) return;
      queryClient.clear();
    };
    window.addEventListener('auth:session-expired', onSessionExpired);
    return () => window.removeEventListener('auth:session-expired', onSessionExpired);
  }, [queryClient]);

  // Cross-tab token writes. `storage` fires only in OTHER tabs (never the
  // writer), so same-tab recovery is handled by the reactive token store.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACCESS_KEY) return;

      // (a) cross-tab logout: token removed elsewhere. Wipe ALL cache so a
      // re-login as a different user can't read the previous user's pages /
      // notifications. The redirect itself is owned by the (auth)/(admin)
      // layout guard, which the reactive store's presence flip (hasToken →
      // false) triggers — pushing here too would race it with a second,
      // param-less /login target.
      if (e.newValue == null) {
        if (isReauthSuppressed()) {
          // Editor with an unsaved buffer: don't clear. Open the inline modal
          // so the user re-auths in place. Without this, a tab lacking a
          // refresh token never receives `auth:session-expired` from the 401
          // path (api-client.ts `if (refreshToken)` guard) and stays stuck on
          // an authed-looking but invalid editor.
          window.dispatchEvent(new CustomEvent('auth:session-expired'));
          return;
        }
        queryClient.clear();
        return;
      }

      // (b) cross-tab token VALUE change (different non-null token). This is
      // EITHER a genuine account switch (different user) OR — far more often — a
      // same-user silent refresh: api-client writes a fresh JWT on every
      // /auth/refresh, and other tabs see exactly oldValue!=newValue too. Only a
      // real user change should wipe the cache; treating a silent refresh as a
      // switch would nuke the cache and flash a spinner on every (hourly) token
      // rotation. Compare the `userId` claim to tell them apart.
      if (e.oldValue != null && e.oldValue !== e.newValue) {
        const prevUser = readUserId(e.oldValue);
        const nextUser = readUserId(e.newValue);
        // Same user, or an unclassifiable token (decode failed) → assume same:
        // do nothing. The reactive store keeps `enabled` true and the active
        // auth observer already holds the right user.
        if (prevUser == null || nextUser == null || prevUser === nextUser) return;

        // Genuinely different user: account switch. Presence stays true so the
        // reactive `enabled` never flips — drop the previous user's non-auth
        // cache and reset the auth query so the active observer refetches
        // /auth/me for the new user. `clear()` + `refetchQueries` is a v5 no-op
        // (clear removes the query first), so use removeQueries + resetQueries.
        if (isReauthSuppressed()) {
          window.dispatchEvent(new CustomEvent('auth:session-expired'));
          return;
        }
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== authKeys.all[0] });
        void queryClient.resetQueries({ queryKey: authKeys.me() });
        return;
      }

      // (c) cross-tab login / silent-refresh value bump (oldValue == null or
      // identical value): nothing to do — the reactive token store flips
      // `useAuth`'s `enabled`, and session-reauth-context's own storage handler
      // closes any open modal.
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);

  // Silent refresh succeeded (notifyTokenRefreshed): the auth query is active
  // (enabled:true) so invalidate refetches it — the disabled-stale filter
  // problem (which breaks invalidate for token-presence flips) doesn't apply.
  useEffect(() => {
    return subscribeTokenRefreshed(() => {
      void queryClient.invalidateQueries({ queryKey: authKeys.me(), refetchType: 'active' });
    });
  }, [queryClient]);

  // Connection "retry" button → refetch the auth query. Token is present and
  // the observer active in that context, so `refetchQueries` passes the
  // `!isDisabled()` filter. Registered ONCE here, not in the 15× useAuth.
  useEffect(() => {
    registerRetryCallback(() => {
      void queryClient.refetchQueries({ queryKey: authKeys.me() });
    });
  }, [registerRetryCallback, queryClient]);

  return null;
}
