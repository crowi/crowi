import type { CollabStatus } from './use-collab-document';

/**
 * The toast side effect a collab status transition should produce. Kept
 * separate from the rendering so the decision is pure + unit-testable.
 *
 * - `offline` — the socket dropped; show a persistent "you're offline" error.
 * - `reconnecting` — the wsToken was rejected (`auth-failed`); silent recovery
 *   (access-token refresh → fresh wsToken → provider rebuild) is automatic, so
 *   show a non-alarming "reconnecting…" indicator, NOT a terminal "reload"
 *   instruction. A genuinely dead session (refresh token also expired) is
 *   handled out-of-band by the SessionReauthModal (`auth:session-expired`).
 * - `reconnected` — `connected` after any interruption; clear the persistent
 *   toast and confirm recovery.
 * - `none` — nothing to show.
 */
export type CollabStatusToast = { type: 'offline' | 'reconnecting' | 'reconnected' | 'none' };

/** Carries whether we're mid-interruption so the next `connected` confirms recovery. */
export interface CollabToastState {
  interrupted: boolean;
}

/**
 * Decide the toast for a collab status transition.
 *
 * Why this exists: the previous inline logic gated the "reconnected"
 * confirmation on a `wasOfflineRef` that was only set on `disconnected`. The
 * silent-recovery path is `auth-failed → connecting → connected` and never
 * passes through `disconnected`, so the persistent "session expired — reload"
 * toast was never cleared after a successful reconnect — making an editor that
 * HAD silently reconnected look broken. Tracking a single `interrupted` flag
 * that BOTH `disconnected` and `auth-failed` set fixes that.
 */
export function reduceCollabStatusToast(
  state: CollabToastState,
  prev: CollabStatus,
  next: CollabStatus,
): { state: CollabToastState; toast: CollabStatusToast } {
  if (next === prev) return { state, toast: { type: 'none' } };
  if (next === 'disconnected') return { state: { interrupted: true }, toast: { type: 'offline' } };
  if (next === 'auth-failed') return { state: { interrupted: true }, toast: { type: 'reconnecting' } };
  if (next === 'connected' && state.interrupted) return { state: { interrupted: false }, toast: { type: 'reconnected' } };
  return { state, toast: { type: 'none' } };
}
