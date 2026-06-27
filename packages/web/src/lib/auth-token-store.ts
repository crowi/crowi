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
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(ACCESS_KEY) != null;
  } catch {
    // localStorage can throw (Safari private mode, storage disabled). getSnapshot
    // runs during render for every useAuth consumer, so fail soft to "no token"
    // rather than letting the throw propagate through render.
    return false;
  }
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
// Only a PRESENCE change matters to this store: login (null → token) and logout
// (token → null) flip the boolean it exposes. A value → different-value write
// (silent refresh / cross-tab account switch) leaves presence `true`, so
// getSnapshot is unchanged and notifying would be an inert no-op (React bails on
// an equal snapshot). The user swap on a real cross-tab account switch is driven
// by AuthSync's own `storage` listener, not this store.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === ACCESS_KEY && (e.oldValue == null) !== (e.newValue == null)) {
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

/**
 * Subscribe to ANY same-tab access-token change. Backed by the same in-process
 * listener set that `storeTokens` / `clearTokens` notify, so a same-tab account
 * switch (token A → token B, presence stays `true`) reaches the subscriber even
 * though `useHasAccessToken`'s boolean snapshot is unchanged. Returns an
 * unsubscribe fn. (Cross-tab writes arrive via the module `storage` listener
 * above, which only re-notifies on a presence change.)
 */
export function subscribeAuthTokenChange(listener: () => void): () => void {
  return subscribe(listener);
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
