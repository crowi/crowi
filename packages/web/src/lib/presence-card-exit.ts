/**
 * feature-mobile-presence-card — pure exit-lifecycle state machine for the
 * self-only collapse of `MobilePresenceCard`'s default (expanded) variant.
 *
 * Extracted out of the component the same way `presence-anti-flicker.ts`
 * extracts the admission-delay policy: the tricky part (a generation guard
 * that survives a rapid hide→show→hide flip mid-animation) is pure state
 * transition logic with no DOM dependency, so it is unit-testable without
 * mounting React or driving a real CSS transition.
 *
 * ## The problem this solves
 *
 * The card slot animates its `grid-template-rows` track (`0fr` collapsed →
 * `1fr` expanded) rather than being removed from the DOM immediately, so
 * the collapse/expand is visible instead of an abrupt cut. Unmounting only
 * happens once that CSS transition has visually finished. Two signals can
 * report "the transition finished":
 *
 *   - a filtered `transitionend` event on the track (the fast path);
 *   - a fallback `setTimeout` slightly longer than the CSS duration, in
 *     case the browser never fires `transitionend` (e.g. the element was
 *     `display: none`d by an ancestor mid-transition, or the tab was
 *     backgrounded and rAF-driven work was throttled).
 *
 * If the desired visibility flips back to `true` WHILE that exit is still
 * in flight (another viewer joins right as the card was collapsing away),
 * neither the in-flight `transitionend` listener nor the fallback timer
 * must be allowed to unmount the now-visible-again card. `generation` is
 * the guard: every `false → true` edge bumps it, and `completeExit` only
 * takes effect for the generation that was current when ITS exit started.
 */

export interface ExitLifecycleState {
  /** Whether the slot is in the DOM at all. */
  mounted: boolean;
  /**
   * Whether the slot should render at its expanded (`1fr`) track size.
   * `false` while `mounted` is still `true` is the "exiting" window — the
   * CSS transition is playing, the card is still in the DOM, just
   * animating toward collapsed.
   */
  visible: boolean;
  /**
   * Bumped on every `false → true` edge (including one that interrupts an
   * in-flight exit). `completeExit` compares against this to reject a
   * stale completion signal from an exit that got interrupted.
   */
  generation: number;
}

export function createExitLifecycleState(initialVisible: boolean): ExitLifecycleState {
  return { mounted: initialVisible, visible: initialVisible, generation: 0 };
}

export interface ApplyVisibilityResult {
  state: ExitLifecycleState;
  /**
   * Non-null exactly when a NEW exit transition just started (and reduced
   * motion is off): the caller should start/rely on the CSS transition
   * already implied by `state.visible === false` and arm a fallback timer
   * tagged with this generation. `null` in every other case (no-op,
   * entering, or a reduced-motion synchronous exit that already unmounted).
   */
  scheduleFallback: number | null;
}

/**
 * Apply a desired-visibility change (driven by e.g. "is anyone other than
 * self viewing" flipping). Pure — the caller owns all DOM/timer side
 * effects; this only decides what state to move to and whether a fallback
 * timer needs arming.
 */
export function applyVisibility(state: ExitLifecycleState, nextVisible: boolean, reducedMotion: boolean): ApplyVisibilityResult {
  if (nextVisible === state.visible) {
    return { state, scheduleFallback: null };
  }

  if (nextVisible) {
    // Entering — always synchronous: ensure mounted, mark visible, and
    // bump the generation so any exit still in flight for the OLD
    // generation can no longer unmount once its transitionend/fallback
    // fires (see `completeExit`).
    return {
      state: { mounted: true, visible: true, generation: state.generation + 1 },
      scheduleFallback: null,
    };
  }

  // Exiting.
  if (reducedMotion) {
    // No transition plays — unmount synchronously, right now. No timer,
    // no transitionend listener needed for this generation.
    return {
      state: { mounted: false, visible: false, generation: state.generation + 1 },
      scheduleFallback: null,
    };
  }

  const next: ExitLifecycleState = { ...state, visible: false };
  return { state: next, scheduleFallback: next.generation };
}

/**
 * Report that an exit-completion signal (a filtered `transitionend`, or the
 * fallback timer) fired for `generation`. Returns the unmounted state if
 * that generation is still current AND the state is still `visible: false`
 * (i.e. nothing re-entered since); otherwise returns `state` unchanged — a
 * stale signal from an interrupted exit is a no-op.
 */
export function completeExit(state: ExitLifecycleState, generation: number): ExitLifecycleState {
  if (state.generation !== generation || state.visible) {
    return state;
  }
  return { ...state, mounted: false };
}
