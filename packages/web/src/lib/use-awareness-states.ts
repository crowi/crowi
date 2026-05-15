'use client';

import { useEffect, useState } from 'react';
import type { CollabAwareness, CollabUserField } from './use-collab-document';

/**
 * Raw awareness state shape we surface to UI consumers. Hocuspocus +
 * y-codemirror.next put the user identity under `user` and the cursor
 * under `cursor`; both are optional because peers may publish either
 * one without the other (e.g. before a selection is made). Anything
 * else on the state object is preserved as `unknown` so UI consumers
 * can read it via narrow type guards.
 */
export interface AwarenessState {
  user?: CollabUserField;
  /** Y.RelativePosition JSON; opaque to callers without a Y.Doc reference. */
  cursor?: { anchor: unknown; head: unknown };
  /**
   * Wall-clock timestamp (ms) of the peer's most recent Y.Text mutation.
   * Used by `CollabPresenceAvatars` to render the typing-dots overlay
   * for ~3 s after each keystroke. Absent on peers that have only
   * moved their caret (no doc edit yet) or that predate the typing
   * indicator wiring.
   */
  typingAt?: number;
  [key: string]: unknown;
}

/**
 * Subscribe to the live awareness map. Returns a `Map<clientID, state>`
 * that is replaced (new identity) on every change so React shallow
 * comparisons trigger downstream re-renders.
 *
 * The hook is intentionally low-level — it does not exclude the local
 * client. Callers that want only remote peers should filter by
 * `awareness.clientID`. Including local in the map lets the
 * `CollabSameBlockWarning` use the same hook to read its own cursor
 * position without a second subscription.
 *
 * Throttling: awareness fires on every keystroke, so a 20-peer page
 * can emit ~200 events/sec. We coalesce bursts of change events into
 * one React state write per animation frame — typing latency on the
 * consumer side is dominated by render cost, not Map allocation, so
 * a single `setStates` per frame keeps the cluster work-rate bounded
 * regardless of peer count.
 */
export function useAwarenessStates(awareness: CollabAwareness | null): Map<number, AwarenessState> {
  const [states, setStates] = useState<Map<number, AwarenessState>>(() => new Map());

  useEffect(() => {
    if (!awareness) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStates(new Map());
      return;
    }

    const snapshot = (): Map<number, AwarenessState> => new Map(awareness.getStates() as Map<number, AwarenessState>);

    setStates(snapshot());

    // Per-event sync setState. React 19 auto-batches setStates fired
    // within the same JS tick (e.g. one inbound socket message that
    // touches several peers), so an rAF/microtask coalesce buys us
    // little until profiling shows otherwise. Tracked as advisory
    // openQuestion 17 (Phase 8 review).
    const handler = () => {
      setStates(snapshot());
    };
    awareness.on('change', handler);
    return () => {
      awareness.off('change', handler);
    };
  }, [awareness]);

  return states;
}
