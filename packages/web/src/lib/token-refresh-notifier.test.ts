import { describe, expect, it, vi } from 'vitest';
import { notifyTokenRefreshed, subscribeTokenRefreshed } from './token-refresh-notifier';

/**
 * editor-preview-reliability §4 — the silent-refresh-success pub/sub
 * that drives wsToken / presence-token re-fetch.
 */
describe('token-refresh-notifier', () => {
  it('invokes all subscribers on notifyTokenRefreshed', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeTokenRefreshed(a);
    const unsubB = subscribeTokenRefreshed(b);

    notifyTokenRefreshed();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    notifyTokenRefreshed();
    expect(a).toHaveBeenCalledTimes(1); // unsubscribed
    expect(b).toHaveBeenCalledTimes(2);
    unsubB();
  });

  it('isolates a throwing subscriber so others still fire', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const unsubBad = subscribeTokenRefreshed(bad);
    const unsubGood = subscribeTokenRefreshed(good);

    expect(() => notifyTokenRefreshed()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    unsubBad();
    unsubGood();
    consoleSpy.mockRestore();
  });
});
