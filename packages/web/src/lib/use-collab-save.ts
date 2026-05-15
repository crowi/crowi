'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CollabSaveErrorSchema, CollabSaveOkSchema, type CollabSaveError, type CollabSaveMessage, type CollabSaveOk } from '@crowi/api-contract';
import type { StatelessListener } from './use-collab-document';

/**
 * Minimal subset of `useCollabDocument` we need to fire and ack a
 * checkpoint save. Phrased as an interface (not a re-import of the
 * full hook result type) so callers can pass a mock in tests without
 * standing up a fake Hocuspocus provider, and so the hook can be
 * used against any session-shaped object including a parent's
 * memoised slice.
 */
export interface CollabSaveSession {
  status: 'connecting' | 'connected' | 'disconnected' | 'auth-failed';
  readonly: boolean;
  sendStateless: (payload: string) => boolean;
  subscribeStateless: (listener: StatelessListener) => () => void;
}

/**
 * Result of a single save attempt. `'BUSY'` is reserved for the
 * already-pending case (user double-clicked). `'NOT_READY'` covers
 * the un-connected / no-provider branch. `'READONLY'` is the
 * 20-cap defence. `'TIMEOUT'` is the 5-second ack window.
 * Everything else is propagated verbatim from the server.
 */
export type CollabSaveFailureReason = 'BUSY' | 'NOT_READY' | 'READONLY' | 'TIMEOUT' | 'WIRE_FORMAT' | 'SERVER';

export interface CollabSaveFailure {
  reason: CollabSaveFailureReason;
  code?: string;
  message: string;
}

export interface UseCollabSaveResult {
  isSaving: boolean;
  lastError: CollabSaveFailure | null;
  save: () => Promise<CollabSaveOk>;
}

/**
 * Default ack timeout (ms). Picked at 5 sec to keep the Save spinner
 * from hanging indefinitely if the Hocuspocus process is down (the
 * stateless reply needs a round-trip + Mongo write + RFC-0002 render
 * pipeline; on a warm session this is typically well under 1 sec).
 * Anything past 5 sec is "something is wrong on the server" territory
 * and the user should be told to retry.
 */
export const COLLAB_SAVE_TIMEOUT_MS = 5000;

/**
 * RFC-0003 Phase 8 — fires `crowi:save` over the Hocuspocus stateless
 * channel and awaits the `crowi:save-ok` / `crowi:save-error` ack.
 *
 * Concurrency model: at most one save in flight at any time. A
 * double-click rejects the second call with `'BUSY'` rather than
 * queueing — the UI keeps the Save button disabled while `isSaving`
 * is true, so this only fires defensively if a caller wires the
 * mutation outside the disabled state.
 *
 * The hook does NOT show toasts itself — that's the caller's
 * responsibility because the Save button has more context than the
 * hook (e.g. whether to redirect on success).
 */
export function useCollabSave(session: CollabSaveSession | null): UseCollabSaveResult {
  const [isSaving, setIsSaving] = useState(false);
  const [lastError, setLastError] = useState<CollabSaveFailure | null>(null);

  /**
   * Single in-flight save's resolver pair. We could maintain a queue
   * of pending saves but the BUSY semantics above mean there's at
   * most one pending at a time, so a single ref is enough. Kept in a
   * ref (not state) because the resolver doesn't render; it's pure
   * imperative wiring between sendStateless → listener → caller.
   */
  const pendingRef = useRef<{
    resolve: (ok: CollabSaveOk) => void;
    reject: (err: CollabSaveFailure) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const resolvePending = useCallback((kind: 'ok' | 'error', body: CollabSaveOk | CollabSaveError) => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
    if (kind === 'ok') {
      const ok = body as CollabSaveOk;
      setIsSaving(false);
      setLastError(null);
      pending.resolve(ok);
    } else {
      const err = body as CollabSaveError;
      const failure: CollabSaveFailure = { reason: 'SERVER', code: err.code, message: err.message };
      setIsSaving(false);
      setLastError(failure);
      pending.reject(failure);
    }
  }, []);

  // Subscribe to stateless messages and route save acks. We
  // (re-)subscribe whenever the session swaps so a token refresh
  // mid-save doesn't leak the listener to the old provider — Phase 7
  // destroys+recreates the provider on token refresh, and the new
  // `subscribeStateless` returned from the hook is identity-stable
  // across destroys but tied to the new provider's listener set.
  useEffect(() => {
    if (!session) return;
    const handle = session.subscribeStateless((payload: string) => {
      // Stateless channel is a pub/sub fan-out — many message kinds
      // share it. Use `safeParse` so foreign messages (e.g. the
      // force-reload dialog's `crowi:force-reload`) are silently
      // skipped rather than rejecting our pending save.
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Not JSON → not for us.
        return;
      }

      const okMatch = CollabSaveOkSchema.safeParse(parsed);
      if (okMatch.success) {
        resolvePending('ok', okMatch.data);
        return;
      }
      const errMatch = CollabSaveErrorSchema.safeParse(parsed);
      if (errMatch.success) {
        resolvePending('error', errMatch.data);
        return;
      }
      // Neither — leave the pending save alone for the timeout to handle
      // if this was supposed to be its ack.
    });
    return handle;
  }, [session, resolvePending]);

  const save = useCallback((): Promise<CollabSaveOk> => {
    if (!session) {
      const failure: CollabSaveFailure = { reason: 'NOT_READY', message: 'Realtime session is not ready' };
      setLastError(failure);
      return Promise.reject(failure);
    }
    if (session.readonly) {
      const failure: CollabSaveFailure = { reason: 'READONLY', message: 'Session is read-only' };
      setLastError(failure);
      return Promise.reject(failure);
    }
    if (session.status !== 'connected') {
      const failure: CollabSaveFailure = { reason: 'NOT_READY', message: 'Not connected to the collab server' };
      setLastError(failure);
      return Promise.reject(failure);
    }
    if (pendingRef.current) {
      const failure: CollabSaveFailure = { reason: 'BUSY', message: 'A save is already in flight' };
      return Promise.reject(failure);
    }

    const message: CollabSaveMessage = { kind: 'crowi:save' };
    const sent = session.sendStateless(JSON.stringify(message));
    if (!sent) {
      const failure: CollabSaveFailure = { reason: 'NOT_READY', message: 'Failed to send save message' };
      setLastError(failure);
      return Promise.reject(failure);
    }

    setIsSaving(true);
    setLastError(null);
    return new Promise<CollabSaveOk>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingRef.current;
        if (!pending) return;
        pendingRef.current = null;
        const failure: CollabSaveFailure = { reason: 'TIMEOUT', message: 'Save did not complete in time' };
        setIsSaving(false);
        setLastError(failure);
        reject(failure);
      }, COLLAB_SAVE_TIMEOUT_MS);
      pendingRef.current = { resolve, reject, timer };
    });
  }, [session]);

  // Clean up an in-flight save on unmount so the timer doesn't fire
  // into a dead component. The resolver pair would have nobody to
  // notify either way; we mirror the same `'TIMEOUT'` shape just in
  // case a caller still holds the promise.
  useEffect(() => {
    return () => {
      const pending = pendingRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRef.current = null;
      pending.reject({ reason: 'TIMEOUT', message: 'Component unmounted before save completed' });
    };
  }, []);

  return { isSaving, lastError, save };
}
