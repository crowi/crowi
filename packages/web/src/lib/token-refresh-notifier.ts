'use client';

/**
 * editor-preview-reliability §4 — module-level pub/sub that fires when
 * `api-client.ts` successfully completes a SILENT access-token refresh
 * (the 401 → `/auth/refresh` single-flight in `acquireRefreshedToken`).
 *
 * Why a separate signal from `auth:session-expired`: that CustomEvent
 * fires only when refresh FAILS (the session is gone → redirect / inline
 * reauth modal). The realtime layer also needs the opposite signal — a
 * refresh SUCCEEDED — so the short-lived collab / presence tokens, which
 * are independent of the access token but whose HTTP fetch rides the same
 * `apiClient` 401 dance, get re-fetched promptly. Without this, a
 * collab WebSocket that hit `auth-failed` (its wsToken expired around the
 * same time the access token did) would sit idle until use-yjs-token's
 * own ~5-min refetch interval, even though credentials are already fresh.
 *
 * Mirrors the `session-reauth-context` listeners/emit pattern (Set +
 * `emit()`); kept as a standalone module (not inlined into api-client)
 * because `api-client.ts` is framework-free and importing React-query
 * there would couple it to the data layer. Subscribers
 * (`useTokenRefreshSubscription`) live in the hooks.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Notify subscribers that a silent access-token refresh just succeeded.
 * Called from `api-client.ts` after `storeTokens(...)`. Never throws —
 * a listener bug must not break the request that triggered the refresh.
 */
export function notifyTokenRefreshed(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[token-refresh] listener threw', err);
    }
  }
}

/**
 * Subscribe to silent-refresh-success notifications. Returns an
 * unsubscribe function — the standard pub/sub shape so callers can drop
 * it straight into a `useEffect` cleanup slot.
 */
export function subscribeTokenRefreshed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
