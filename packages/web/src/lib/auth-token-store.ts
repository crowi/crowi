'use client';

/**
 * Reactive token-presence store.
 *
 * `useAuth` gates its `/auth/me` query on `enabled: hasToken`. For that gate to
 * be REACTIVE — so a login / logout / silent refresh / inline reauth flips the
 * query on or off — the presence of the access token must be an external store
 * the component subscribes to, not a one-shot `localStorage.getItem` read that
 * freezes at mount.
 *
 * Why this lives in its OWN module (not `auth-token.ts`):
 *   1. whole-module `vi.mock('@/lib/auth-token', () => ({ clearTokens }))`
 *      (session-reauth-context.test.tsx) replaces the *entire* module with
 *      `{ clearTokens }`. Co-locating the store there would erase it under the
 *      mock and break any import path that needs `subscribe` / `notify`.
 *   2. Cycle avoidance. `auth-token.ts` calls this store's `notify` from
 *      `storeTokens` / `clearTokens`, so the only dependency edge is
 *      `auth-token.ts → auth-token-store.ts`. To keep it one-directional the
 *      store reads token presence itself (`localStorage.getItem('accessToken')
 *      != null`) instead of importing `getAccessToken()` back — the duplicated
 *      `'accessToken'` literal is the deliberate cost of having no import cycle.
 *
 * Mirrors the `token-refresh-notifier.ts` ← `api-client.ts` precedent: a
 * `'use client'` module-level store whose `notify` is invoked from a
 * framework-free caller after it mutates the tokens.
 */

import { useSyncExternalStore } from 'react';

// Duplicated from `auth-token.ts`'s ACCESS_KEY on purpose — importing it back
// would create the `auth-token-store → auth-token` cycle this file avoids.
const ACCESS_KEY = 'accessToken';

const listeners = new Set<() => void>();

/** In-process snapshot of access-token presence. */
function readPresence(): boolean {
  return typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) != null : false;
}

/**
 * Notify all subscribers that the access-token presence (or value) may have
 * changed. Called by `storeTokens` / `clearTokens` for SAME-tab writes; the
 * module-level `storage` listener below covers CROSS-tab writes. Never throws —
 * a buggy listener must not break the token write that triggered it.
 */
export function notifyAuthTokenChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[auth-token-store] listener threw', err);
    }
  }
}

// A SINGLE module-level `storage` listener fans out to every subscriber.
// Subscribing per `useSyncExternalStore` call would attach N window listeners
// for N observers → N² notifications. Registered once on module load; the
// in-process `subscribe` below only adds/removes from the listener Set.
//
// React to a write/remove AND a value change (`oldValue !== newValue`): a
// cross-tab account switch writes a DIFFERENT non-null token (presence stays
// `true`), and AuthSync still needs that notify to re-render and swap users.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === ACCESS_KEY && e.oldValue !== e.newValue) {
      notifyAuthTokenChange();
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return readPresence();
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Reactive boolean: does the client currently hold an access token? Drives
 * `useAuth`'s `enabled` gate so a token write/clear flips the `/auth/me` query.
 * SSR-safe: `getServerSnapshot` returns `false` so the server never fetches.
 */
export function useHasAccessToken(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
