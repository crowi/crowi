'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Module-level layout-suppression signal.
 *
 * The `SessionReauthProvider` is mounted *inside* the `(auth)` layout's
 * `{children}` (it lives in the editor route), so the layout — an
 * ancestor — cannot read a React Context the editor provides. Yet the
 * layout is exactly where the redirect-on-unauth logic lives and must
 * be suppressed during inline reauth.
 *
 * A tiny external store bridges that gap without inverting the tree:
 * the provider flips the flag, the layout subscribes via
 * `useReauthSuppressed()` (`useSyncExternalStore`) and reads the live
 * value from event handlers via `isReauthSuppressed()`. Outside the
 * editor the flag is never set, so the layout redirects as before. This
 * is the decoupled, optional-subscription shape the plan called for —
 * realised as a store rather than a context because of the ancestor /
 * descendant direction.
 */
// The signal has two independent contributors, both of which must
// suppress the layout redirect:
//   - `providerCount` > 0: an editor with inline-reauth capability is
//     mounted. This is set on provider mount (BEFORE any session expiry)
//     so the layout's own `auth:session-expired` handler — which is
//     registered first, being an ancestor, and would otherwise win the
//     race — defers to the inline modal as soon as the editor exists.
//   - `pending`: the modal is actually open. Used so the redirect
//     *effect* (the `!isAuthenticated` route) also holds off.
// The layout suppresses whenever either is active.
let providerCount = 0;
let pending = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function reauthSuppressed(): boolean {
  return providerCount > 0 || pending;
}

function incrementProviderCount(): void {
  providerCount += 1;
  emit();
}

function decrementProviderCount(): void {
  providerCount = Math.max(0, providerCount - 1);
  emit();
}

function setReauthPending(next: boolean): void {
  if (pending === next) return;
  pending = next;
  emit();
}

/** Non-reactive read for event handlers that run outside React. */
export function isReauthSuppressed(): boolean {
  return reauthSuppressed();
}

/**
 * Whether the `(auth)` layout should suppress its unauth redirect: true
 * while an editor reauth provider is mounted or its modal is open.
 * Returns `false` everywhere else.
 */
export function useReauthSuppressed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reauthSuppressed(),
    () => false,
  );
}

/**
 * Editor-scoped inline re-authentication.
 *
 * The collab editor keeps the in-progress document in a Y.Doc /
 * CodeMirror buffer that is lost the moment the editor unmounts. When
 * the JWT session expires, the `(auth)` shell would normally redirect
 * to `/login` and throw that buffer away. This context lets the editor
 * keep the buffer mounted and re-authenticate in place instead.
 *
 * Detection is single-sourced through `api-client.ts`'s shared,
 * single-flight `/auth/refresh` path: when the refresh token is still
 * valid the access token is refreshed transparently (silent recovery,
 * no modal); only when refresh itself fails does `refreshAccessToken`
 * dispatch the `auth:session-expired` CustomEvent. This provider
 * listens for that one event and raises `isReauthing`, so there is no
 * per-endpoint 401 handling and the modal can never double-open (one
 * boolean state, riding the `refreshPromise` single-flight).
 *
 * The provider also raises a module-level suppression signal (see
 * `useReauthSuppressed` / `isReauthSuppressed`) that the `(auth)` layout
 * — an *ancestor* of this provider — reads to skip its redirect while an
 * inline-reauth editor is mounted. Outside the editor the signal is
 * never raised, so the layout redirects as before. The in-tree consumer
 * (the modal) reads the React Context via `useSessionReauthRequired()`.
 */

interface SessionReauthContextValue {
  /** `true` while the inline reauth modal should be shown (redirect suppressed). */
  isReauthing: boolean;
  /**
   * Email of the user who was editing, captured the instant the session
   * expired (before `clearTokens` drops `useAuth().user`). Pre-fills the
   * modal's email field. `''` when unavailable.
   */
  reauthEmail: string;
  /**
   * Called by the modal after a successful login (this tab) — clears
   * `isReauthing` and refetches the short-lived collab + presence tokens
   * so both WebSockets reconnect with fresh credentials.
   */
  resolveReauth: () => void;
}

const SessionReauthContext = createContext<SessionReauthContextValue | null>(null);

/**
 * Hook for the modal — throws outside the provider because the
 * modal is only ever rendered as a child of `SessionReauthProvider`.
 */
export function useSessionReauthRequired(): SessionReauthContextValue {
  const ctx = useContext(SessionReauthContext);
  if (!ctx) throw new Error('useSessionReauthRequired must be used within a SessionReauthProvider');
  return ctx;
}

export function SessionReauthProvider({
  pageId,
  currentEmail,
  children,
}: {
  /** The page being edited — scopes which token queries to refetch on recovery. */
  pageId: string;
  /** Current user's email, snapshotted into the modal when the session drops. */
  currentEmail: string | null | undefined;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [isReauthing, setIsReauthingState] = useState(false);
  const [reauthEmail, setReauthEmail] = useState('');

  // Keep the local React state and the module-level layout signal in
  // lock-step so the modal (in-tree) and the (auth) layout (ancestor)
  // see the same value.
  const setIsReauthing = useCallback((next: boolean) => {
    setIsReauthingState(next);
    setReauthPending(next);
  }, []);

  // Register this provider so the (auth) layout knows an inline-reauth-
  // capable editor is mounted and defers its redirect to the modal. The
  // cleanup also clears any lingering `pending` so a stray `true` can't
  // outlive the provider.
  useEffect(() => {
    incrementProviderCount();
    return () => {
      decrementProviderCount();
      setReauthPending(false);
    };
  }, []);

  // Keep the latest known email in a ref so the `auth:session-expired`
  // listener (registered once) always snapshots the freshest value —
  // by the time the event fires `clearTokens` has already run and the
  // React `user` may be on its way out.
  const emailRef = useRef(currentEmail ?? '');
  useEffect(() => {
    if (currentEmail) emailRef.current = currentEmail;
  }, [currentEmail]);

  // Mirror of `isReauthing` for the `storage` listener (registered once)
  // to read without re-subscribing on every state flip.
  const isReauthingRef = useRef(isReauthing);
  useEffect(() => {
    isReauthingRef.current = isReauthing;
  }, [isReauthing]);

  /**
   * Force a reconnect of the collab + presence WebSockets after fresh
   * tokens land. The token values themselves may be byte-identical to
   * what react-query already cached (same pageId, server may re-issue
   * an equivalent token), so a plain `refetch` could dedupe into a
   * no-op that never re-runs the connection effects. `invalidateQueries`
   * with `refetchType: 'active'` guarantees the mounted observers
   * refetch, and the resulting query-data change re-runs
   * `useYjsToken` / `usePresenceToken`'s consumers (provider rebuild,
   * presence reconnect).
   */
  const refetchTokens = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['yjsToken', pageId], refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['presenceToken', pageId], refetchType: 'active' });
  }, [queryClient, pageId]);

  const resolveReauth = useCallback(() => {
    setIsReauthing(false);
    refetchTokens();
  }, [refetchTokens, setIsReauthing]);

  // Detection: ride the shared single-flight refresh failure signal.
  useEffect(() => {
    const handleSessionExpired = () => {
      setReauthEmail(emailRef.current);
      setIsReauthing(true);
    };
    window.addEventListener('auth:session-expired', handleSessionExpired);
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired);
  }, [setIsReauthing]);

  // Multi-tab recovery: another editor tab re-authenticated and wrote a
  // fresh token pair to localStorage. The `storage` event only fires in
  // *other* tabs (never the writer), so this closes the modal here and
  // refetches tokens to reconnect — without the user re-logging in on
  // every open tab.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      // Only react to an access-token write that produced a value (a
      // login / refresh). `clearTokens` sets it to null — ignore that,
      // since a logout in another tab should not silently revive this
      // editor.
      if (e.key !== 'accessToken' || e.newValue == null) return;
      if (!isReauthingRef.current) return;
      setIsReauthing(false);
      refetchTokens();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [refetchTokens, setIsReauthing]);

  const value = useMemo<SessionReauthContextValue>(() => ({ isReauthing, reauthEmail, resolveReauth }), [isReauthing, reauthEmail, resolveReauth]);

  return <SessionReauthContext.Provider value={value}>{children}</SessionReauthContext.Provider>;
}
