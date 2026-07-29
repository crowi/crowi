import { describe, expect, it } from 'vitest';
import { applyVisibility, completeExit, createExitLifecycleState } from './presence-card-exit';

describe('createExitLifecycleState', () => {
  it('starts mounted+visible when initialVisible is true', () => {
    expect(createExitLifecycleState(true)).toEqual({ mounted: true, visible: true, generation: 0 });
  });

  it('starts unmounted when initialVisible is false', () => {
    expect(createExitLifecycleState(false)).toEqual({ mounted: false, visible: false, generation: 0 });
  });
});

describe('applyVisibility', () => {
  it('is a no-op when the requested visibility already matches', () => {
    const state = createExitLifecycleState(true);
    const result = applyVisibility(state, true, false);
    expect(result.state).toBe(state);
    expect(result.scheduleFallback).toBeNull();
  });

  it('entering mounts synchronously and bumps the generation', () => {
    const state = createExitLifecycleState(false);
    const result = applyVisibility(state, true, false);
    expect(result.state).toEqual({ mounted: true, visible: true, generation: 1 });
    expect(result.scheduleFallback).toBeNull();
  });

  it('exiting (motion allowed) stays mounted, flips visible false, and asks the caller to schedule a fallback for the CURRENT generation', () => {
    const state = createExitLifecycleState(true);
    const result = applyVisibility(state, false, false);
    expect(result.state).toEqual({ mounted: true, visible: false, generation: 0 });
    expect(result.scheduleFallback).toBe(0);
  });

  it('exiting under reduced motion unmounts synchronously — no fallback to schedule', () => {
    const state = createExitLifecycleState(true);
    const result = applyVisibility(state, false, true);
    expect(result.state).toEqual({ mounted: false, visible: false, generation: 1 });
    expect(result.scheduleFallback).toBeNull();
  });

  it('re-entering mid-exit bumps the generation again, invalidating the in-flight exit', () => {
    const visible = createExitLifecycleState(true);
    const exiting = applyVisibility(visible, false, false);
    expect(exiting.state.generation).toBe(0);

    const reentered = applyVisibility(exiting.state, true, false);
    expect(reentered.state).toEqual({ mounted: true, visible: true, generation: 1 });
  });
});

describe('completeExit', () => {
  it('unmounts when the generation matches and the state is still exiting (visible: false)', () => {
    const visible = createExitLifecycleState(true);
    const { state: exiting, scheduleFallback } = applyVisibility(visible, false, false);
    expect(scheduleFallback).toBe(0);

    const completed = completeExit(exiting, 0);
    expect(completed).toEqual({ mounted: false, visible: false, generation: 0 });
  });

  it('AC: false->true before the 200ms exit completes must NOT unmount a visible card — a stale generation completion is a no-op', () => {
    const visible = createExitLifecycleState(true);
    const { state: exiting } = applyVisibility(visible, false, false); // generation 0, exiting
    const { state: reentered } = applyVisibility(exiting, true, false); // generation 1, visible again

    // The OLD generation-0 exit's transitionend/fallback fires late.
    const afterStaleSignal = completeExit(reentered, 0);
    expect(afterStaleSignal).toBe(reentered);
    expect(afterStaleSignal.mounted).toBe(true);
    expect(afterStaleSignal.visible).toBe(true);
  });

  it('is a no-op when the generation is current but visible flipped back to true without going through applyVisibility (defensive)', () => {
    const state: ReturnType<typeof createExitLifecycleState> = { mounted: true, visible: true, generation: 0 };
    expect(completeExit(state, 0)).toBe(state);
  });

  it('a fallback timer tagged with a superseded generation is a no-op even if it fires AFTER a later exit has already started', () => {
    const visible = createExitLifecycleState(true);
    const firstExit = applyVisibility(visible, false, false); // gen 0
    const reentered = applyVisibility(firstExit.state, true, false); // gen 1
    const secondExit = applyVisibility(reentered.state, false, false); // still gen 1, now exiting again
    expect(secondExit.scheduleFallback).toBe(1);

    // The generation-0 fallback (from the FIRST exit) fires now — must not
    // touch the state, even though the state IS currently `visible: false`
    // again (from the second, unrelated exit).
    const afterStaleFallback = completeExit(secondExit.state, 0);
    expect(afterStaleFallback).toBe(secondExit.state);

    // The correctly-tagged generation-1 completion DOES take effect.
    const completed = completeExit(secondExit.state, 1);
    expect(completed.mounted).toBe(false);
  });
});
