import { describe, expect, it } from 'vitest';
import { type CollabToastState, reduceCollabStatusToast } from './collab-status-toast';

const fresh: CollabToastState = { interrupted: false };

describe('reduceCollabStatusToast', () => {
  it('no toast on the initial connecting → connected (never interrupted)', () => {
    const r = reduceCollabStatusToast(fresh, 'connecting', 'connected');
    expect(r.toast.type).toBe('none');
    expect(r.state.interrupted).toBe(false);
  });

  it('disconnected shows the persistent offline toast and marks interrupted', () => {
    const r = reduceCollabStatusToast(fresh, 'connected', 'disconnected');
    expect(r.toast.type).toBe('offline');
    expect(r.state.interrupted).toBe(true);
  });

  it('auth-failed shows a reconnecting toast (NOT a terminal reload) and marks interrupted', () => {
    const r = reduceCollabStatusToast(fresh, 'connected', 'auth-failed');
    expect(r.toast.type).toBe('reconnecting');
    expect(r.state.interrupted).toBe(true);
  });

  it('clears with reconnected when connected returns AFTER an auth-failed (the stale-toast bug)', () => {
    // The provider rebuild path is auth-failed → connecting → connected and
    // never passes through `disconnected`; the old `wasOfflineRef` gate left
    // the "session expired — reload" toast on screen forever after a
    // successful silent reconnect.
    let state = reduceCollabStatusToast(fresh, 'connected', 'auth-failed').state;
    expect(reduceCollabStatusToast(state, 'auth-failed', 'connecting').toast.type).toBe('none');
    state = reduceCollabStatusToast(state, 'auth-failed', 'connecting').state; // still interrupted
    const r = reduceCollabStatusToast(state, 'connecting', 'connected');
    expect(r.toast.type).toBe('reconnected');
    expect(r.state.interrupted).toBe(false);
  });

  it('clears with reconnected when connected returns after an offline drop', () => {
    let state = reduceCollabStatusToast(fresh, 'connected', 'disconnected').state;
    state = reduceCollabStatusToast(state, 'disconnected', 'connecting').state;
    const r = reduceCollabStatusToast(state, 'connecting', 'connected');
    expect(r.toast.type).toBe('reconnected');
    expect(r.state.interrupted).toBe(false);
  });

  it('no toast and no state change on a same-status no-op transition', () => {
    const interrupted: CollabToastState = { interrupted: true };
    const r = reduceCollabStatusToast(interrupted, 'auth-failed', 'auth-failed');
    expect(r.toast.type).toBe('none');
    expect(r.state).toBe(interrupted);
  });

  it('does not emit reconnected when connected without a prior interruption', () => {
    const r = reduceCollabStatusToast(fresh, 'connecting', 'connected');
    expect(r.toast.type).toBe('none');
  });
});
