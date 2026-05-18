import { describe, it, expect } from 'vitest';
import type { PresenceViewer } from '@crowi/api-contract';
import { PRESENCE_FLICKER_DELAY_MS, createAntiFlickerState, ingestBroadcast, refreshAdmissions, visibleViewers } from './presence-anti-flicker';

function viewer(userId: string, overrides: Partial<PresenceViewer> = {}): PresenceViewer {
  return {
    userId,
    username: userId,
    displayName: `User ${userId}`,
    avatarUrl: null,
    isEditing: false,
    joinedAt: 1_000,
    ...overrides,
  };
}

describe('presence anti-flicker', () => {
  it('hides a newly-joined viewer until the 3s grace period elapses', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    ingestBroadcast(state, [viewer('alice')], t0);
    // Immediately after join: not yet admitted, not rendered.
    expect(visibleViewers(state, null)).toHaveLength(0);

    // Still inside the grace window.
    refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS - 1);
    expect(visibleViewers(state, null)).toHaveLength(0);

    // Grace period elapsed → admitted and rendered.
    refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(visibleViewers(state, null).map((v) => v.userId)).toEqual(['alice']);
  });

  it('skips a viewer that joins and leaves within the grace period', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    // Alice appears…
    ingestBroadcast(state, [viewer('alice')], t0);
    // …then leaves 2s later, before the 3s admission timer fires.
    ingestBroadcast(state, [], t0 + 2_000);

    // Even well past the original grace window she never shows.
    refreshAdmissions(state, t0 + 10_000);
    expect(visibleViewers(state, null)).toHaveLength(0);
  });

  it('returns the earliest dueAt for pending viewers', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    const first = ingestBroadcast(state, [viewer('alice')], t0);
    expect(first.dueAt).toBe(t0 + PRESENCE_FLICKER_DELAY_MS);

    // Bob joins 1s later — alice is still the earliest due.
    const second = ingestBroadcast(state, [viewer('alice'), viewer('bob')], t0 + 1_000);
    expect(second.dueAt).toBe(t0 + PRESENCE_FLICKER_DELAY_MS);

    // Once alice is admitted, dueAt advances to bob's deadline.
    const third = refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(third.dueAt).toBe(t0 + 1_000 + PRESENCE_FLICKER_DELAY_MS);
  });

  it('reports null dueAt when nothing is pending', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;
    ingestBroadcast(state, [viewer('alice')], t0);
    const result = refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(result.dueAt).toBeNull();
  });

  it('keeps an admitted viewer admitted across later broadcasts (no re-delay)', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    ingestBroadcast(state, [viewer('alice')], t0);
    refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(visibleViewers(state, null)).toHaveLength(1);

    // A later broadcast that still contains alice must not re-delay her.
    ingestBroadcast(state, [viewer('alice'), viewer('bob')], t0 + 20_000);
    expect(visibleViewers(state, null).map((v) => v.userId)).toEqual(['alice']);
  });

  it('always shows the current user immediately, with no grace delay', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    ingestBroadcast(state, [viewer('me'), viewer('alice')], t0);
    // `me` is rendered right away; alice still waits out the grace period.
    expect(visibleViewers(state, 'me').map((v) => v.userId)).toEqual(['me']);
  });

  it('orders visible viewers by joinedAt', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    ingestBroadcast(state, [viewer('late', { joinedAt: 5_000 }), viewer('early', { joinedAt: 1_000 })], t0);
    refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(visibleViewers(state, null).map((v) => v.userId)).toEqual(['early', 'late']);
  });

  it('drops a viewer that leaves after being admitted', () => {
    const state = createAntiFlickerState();
    const t0 = 10_000;

    ingestBroadcast(state, [viewer('alice')], t0);
    refreshAdmissions(state, t0 + PRESENCE_FLICKER_DELAY_MS);
    expect(visibleViewers(state, null)).toHaveLength(1);

    ingestBroadcast(state, [], t0 + 20_000);
    expect(visibleViewers(state, null)).toHaveLength(0);
  });
});
