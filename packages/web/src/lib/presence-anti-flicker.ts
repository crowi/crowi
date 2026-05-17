import type { PresenceViewer } from '@crowi/api-contract';

/**
 * RFC-0005 §"Anti-flicker delay" — client-side smoothing of the live
 * presence avatar stack.
 *
 * The presence server broadcasts viewer-list changes as they happen.
 * A user who opens a page in a new tab and immediately closes it (or
 * a redirect chain) would otherwise flash in and out of every other
 * viewer's avatar stack. To avoid that churn the client delays adding
 * a *newly seen* viewer to the rendered stack by 3 seconds; if the
 * viewer has already left before the delay elapses, the addition is
 * skipped entirely.
 *
 * This module is the pure, framework-free core of that policy so it
 * can be unit-tested without a WebSocket or React. `use-presence.ts`
 * drives it with timers.
 */

/** Default anti-flicker grace period before a new avatar is shown. */
export const PRESENCE_FLICKER_DELAY_MS = 3000;

/**
 * Per-viewer admission state held between broadcasts.
 *
 *   - `firstSeenAt`  — epoch-ms of the first broadcast this viewer
 *                      appeared in. Drives the 3s admission timer.
 *   - `admitted`     — once `true`, the viewer is rendered immediately
 *                      on every subsequent broadcast (no re-delay if
 *                      they briefly drop and rejoin within the same
 *                      session — re-delaying would itself flicker).
 */
export interface ViewerAdmission {
  firstSeenAt: number;
  admitted: boolean;
}

export interface AntiFlickerState {
  /** Latest viewer list received from the server, keyed by userId. */
  latest: Map<string, PresenceViewer>;
  /** Admission bookkeeping, keyed by userId. */
  admissions: Map<string, ViewerAdmission>;
}

export function createAntiFlickerState(): AntiFlickerState {
  return { latest: new Map(), admissions: new Map() };
}

/**
 * Fold a fresh server broadcast into the anti-flicker state.
 *
 * `now` and `delayMs` are injected so tests can drive time
 * deterministically. Returns the same `state` object, mutated in
 * place, plus a `dueAt` timestamp: the earliest moment a
 * currently-pending viewer becomes admissible, or `null` when nothing
 * is pending. The caller schedules a re-evaluation at `dueAt`.
 */
export function ingestBroadcast(
  state: AntiFlickerState,
  viewers: PresenceViewer[],
  now: number,
  delayMs: number = PRESENCE_FLICKER_DELAY_MS,
): { dueAt: number | null } {
  const seen = new Set<string>();
  state.latest = new Map();

  for (const viewer of viewers) {
    seen.add(viewer.userId);
    state.latest.set(viewer.userId, viewer);
    const existing = state.admissions.get(viewer.userId);
    if (!existing) {
      // First time we have ever seen this viewer — start the timer.
      state.admissions.set(viewer.userId, { firstSeenAt: now, admitted: false });
    }
  }

  // Drop admission bookkeeping for viewers that left. If they left
  // before being admitted, the avatar simply never appeared — exactly
  // the flicker we wanted to suppress.
  for (const userId of [...state.admissions.keys()]) {
    if (!seen.has(userId)) {
      state.admissions.delete(userId);
    }
  }

  return { dueAt: nextDueAt(state, now, delayMs) };
}

/**
 * Re-evaluate admissions at the current time, promoting any viewer
 * whose 3s grace period has elapsed. Returns the next `dueAt` (or
 * `null`). Idempotent — safe to call from a timer or a render.
 */
export function refreshAdmissions(state: AntiFlickerState, now: number, delayMs: number = PRESENCE_FLICKER_DELAY_MS): { dueAt: number | null } {
  for (const [userId, admission] of state.admissions) {
    if (!admission.admitted && now - admission.firstSeenAt >= delayMs) {
      admission.admitted = true;
      state.admissions.set(userId, admission);
    }
  }
  return { dueAt: nextDueAt(state, now, delayMs) };
}

function nextDueAt(state: AntiFlickerState, now: number, delayMs: number): number | null {
  let due: number | null = null;
  for (const admission of state.admissions.values()) {
    if (admission.admitted) continue;
    const at = admission.firstSeenAt + delayMs;
    if (at <= now) {
      // Already elapsed but not yet folded in — caller should refresh
      // immediately rather than wait.
      return now;
    }
    if (due === null || at < due) due = at;
  }
  return due;
}

/**
 * Project the current state to the viewer list the UI should render:
 * only viewers whose admission grace period has elapsed. The current
 * user is *always* shown immediately (no flicker risk — you opened
 * the page yourself) when `selfUserId` is supplied.
 *
 * Ordering is stable by `joinedAt` so avatars don't reshuffle on every
 * broadcast.
 */
export function visibleViewers(state: AntiFlickerState, selfUserId: string | null): PresenceViewer[] {
  const out: PresenceViewer[] = [];
  for (const [userId, viewer] of state.latest) {
    if (selfUserId !== null && userId === selfUserId) {
      out.push(viewer);
      continue;
    }
    if (state.admissions.get(userId)?.admitted) {
      out.push(viewer);
    }
  }
  out.sort((a, b) => a.joinedAt - b.joinedAt);
  return out;
}
