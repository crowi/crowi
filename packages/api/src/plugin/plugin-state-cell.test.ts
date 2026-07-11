/**
 * Pure unit tests for `createStateCell()` — no Mongo / Crowi mocking
 * needed (see `feature-plugin-state-cell-primitive` spec's `test` item).
 * Covers AC-1 (get/withValue/set shape) and AC-3 (dispose-drain timing):
 *   (a) set() swaps what get()/withValue() see.
 *   (b) an in-flight withValue() defers a concurrent set()'s dispose
 *       until that withValue() settles.
 *   (c) with no in-flight withValue(), dispose runs on the next
 *       microtask — not inline from set().
 *   (d) several back-to-back set() calls each dispose their own
 *       generation only once ITS in-flight callers have settled.
 */
import { createStateCell } from './plugin-state-cell';

/** Flush pending microtasks a few times — enough for dispose's `Promise.resolve().then(...)` chain to run. */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('createStateCell — (a) get()/withValue() before and after set()', () => {
  it('get() returns the initial value, then the swapped-in value after set()', () => {
    const cell = createStateCell({ n: 1 });
    expect(cell.get()).toEqual({ n: 1 });

    cell.set({ n: 2 });
    expect(cell.get()).toEqual({ n: 2 });
  });

  it('withValue() sees the initial value, then the swapped-in value after set()', async () => {
    const cell = createStateCell({ n: 1 });
    await expect(cell.withValue((v) => v)).resolves.toEqual({ n: 1 });

    cell.set({ n: 2 });
    await expect(cell.withValue((v) => v)).resolves.toEqual({ n: 2 });
  });

  it('withValue() propagates a synchronous return value', async () => {
    const cell = createStateCell(5);
    await expect(cell.withValue((v) => v * 2)).resolves.toBe(10);
  });

  it('withValue() propagates a rejection from fn without disposing early', async () => {
    const cell = createStateCell(1);
    await expect(
      cell.withValue(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('createStateCell — (b) set({ dispose }) during an in-flight withValue() defers dispose until it settles', () => {
  it('does not call dispose while the in-flight withValue() that captured the previous value is still running', async () => {
    const cell = createStateCell('v1');
    const dispose = jest.fn();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const inflight = cell.withValue(async (v) => {
      await gate;
      return v;
    });

    // Let withValue() reach `await gate` (refCount is now incremented).
    await flushMicrotasks();

    cell.set('v2', { dispose });
    // The swap is visible immediately...
    expect(cell.get()).toBe('v2');
    // ...but dispose must not have run yet — the in-flight withValue()
    // against 'v1' hasn't settled.
    await flushMicrotasks();
    expect(dispose).not.toHaveBeenCalled();

    release?.();
    await inflight;
    await flushMicrotasks();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('v1');
  });

  it('still defers dispose when the in-flight withValue() rejects (resolve/reject both count as settled)', async () => {
    const cell = createStateCell('v1');
    const dispose = jest.fn();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const inflight = cell.withValue(async () => {
      await gate;
      throw new Error('inflight failure');
    });
    await flushMicrotasks();

    cell.set('v2', { dispose });
    await flushMicrotasks();
    expect(dispose).not.toHaveBeenCalled();

    release?.();
    await expect(inflight).rejects.toThrow('inflight failure');
    await flushMicrotasks();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('v1');
  });
});

describe('createStateCell — (c) set({ dispose }) with no in-flight withValue() fires on the next microtask, not inline', () => {
  it('dispose has not run synchronously right after set() returns', () => {
    const cell = createStateCell('v1');
    const dispose = jest.fn();

    cell.set('v2', { dispose });

    expect(dispose).not.toHaveBeenCalled();
  });

  it('dispose has run once microtasks are flushed', async () => {
    const cell = createStateCell('v1');
    const dispose = jest.fn();

    cell.set('v2', { dispose });
    await flushMicrotasks();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('v1');
  });

  it('omitting opts.dispose is safe (no callback, no throw)', async () => {
    const cell = createStateCell('v1');
    expect(() => cell.set('v2')).not.toThrow();
    await flushMicrotasks();
    expect(cell.get()).toBe('v2');
  });
});

describe('createStateCell — (d) several consecutive set() calls dispose each generation independently, waiting on that generation’s own in-flight callers', () => {
  it('disposes gen0 and gen1 in order once each one’s in-flight withValue() settles, never disposing the live generation', async () => {
    const cell = createStateCell('v0');
    const disposeLog: string[] = [];

    let releaseGen0: (() => void) | undefined;
    const gen0Gate = new Promise<void>((r) => {
      releaseGen0 = r;
    });
    const gen0Inflight = cell.withValue(async (v) => {
      await gen0Gate;
      return v;
    });
    await flushMicrotasks();

    // gen0 -> gen1, with an in-flight caller still holding gen0.
    cell.set('v1', { dispose: (prev) => void disposeLog.push(`dispose:${prev}`) });

    let releaseGen1: (() => void) | undefined;
    const gen1Gate = new Promise<void>((r) => {
      releaseGen1 = r;
    });
    const gen1Inflight = cell.withValue(async (v) => {
      await gen1Gate;
      return v;
    });
    await flushMicrotasks();

    // gen1 -> gen2, with an in-flight caller still holding gen1. Neither
    // gen0 (still in flight) nor gen1 (still in flight) may be disposed yet.
    cell.set('v2', { dispose: (prev) => void disposeLog.push(`dispose:${prev}`) });
    await flushMicrotasks();
    expect(disposeLog).toEqual([]);

    // Settle gen0's in-flight caller: only gen0 disposes.
    releaseGen0?.();
    await gen0Inflight;
    await flushMicrotasks();
    expect(disposeLog).toEqual(['dispose:v0']);

    // Settle gen1's in-flight caller: gen1 disposes too. gen2 (the live
    // generation) is never disposed.
    releaseGen1?.();
    await gen1Inflight;
    await flushMicrotasks();
    expect(disposeLog).toEqual(['dispose:v0', 'dispose:v1']);
    expect(cell.get()).toBe('v2');
  });

  it('several set() calls with no in-flight callers each dispose in order on their own microtask', async () => {
    const cell = createStateCell('v0');
    const disposeLog: string[] = [];

    cell.set('v1', { dispose: (prev) => void disposeLog.push(`dispose:${prev}`) });
    cell.set('v2', { dispose: (prev) => void disposeLog.push(`dispose:${prev}`) });
    cell.set('v3');

    await flushMicrotasks();

    expect(disposeLog).toEqual(['dispose:v0', 'dispose:v1']);
    expect(cell.get()).toBe('v3');
  });
});
