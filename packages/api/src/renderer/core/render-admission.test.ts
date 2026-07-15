import type { RenderActor } from '@crowi/plugin-api';
import { _resetAllPoolsForTest, acquireRenderSlot, RenderAdmissionAbortedError, RenderAdmissionQueueOverflowError } from './render-admission';

const CONFIG = { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 };

const user = (id: string): RenderActor => ({ kind: 'user', userId: id });

beforeEach(() => {
  _resetAllPoolsForTest();
});

describe('acquireRenderSlot', () => {
  it('(a) grants up to maxConcurrentGlobal immediately, queues the rest, and grants them once a slot releases', async () => {
    const tickets = await Promise.all(
      Array.from({ length: 4 }, (_, i) => acquireRenderSlot({ pluginName: 'p-a', actor: user(`u${i}`), priority: 'high', admissionControl: CONFIG })),
    );
    expect(tickets).toHaveLength(4);

    let fifthGranted = false;
    const fifth = acquireRenderSlot({ pluginName: 'p-a', actor: user('u5'), priority: 'high', admissionControl: CONFIG }).then((t) => {
      fifthGranted = true;
      return t;
    });
    // Give the microtask queue a tick — the 5th request must still be
    // waiting, not granted, while all 4 slots are held.
    await Promise.resolve();
    await Promise.resolve();
    expect(fifthGranted).toBe(false);

    tickets[0].release();
    const fifthTicket = await fifth;
    expect(fifthGranted).toBe(true);
    fifthTicket.release();
  });

  it('(b) caps per-user concurrency even when the global pool has room', async () => {
    const first = await acquireRenderSlot({ pluginName: 'p-b', actor: user('u1'), priority: 'high', admissionControl: CONFIG });
    const second = await acquireRenderSlot({ pluginName: 'p-b', actor: user('u1'), priority: 'high', admissionControl: CONFIG });

    let thirdGranted = false;
    const third = acquireRenderSlot({ pluginName: 'p-b', actor: user('u1'), priority: 'high', admissionControl: CONFIG }).then((t) => {
      thirdGranted = true;
      return t;
    });
    await Promise.resolve();
    await Promise.resolve();
    // Global pool has 2 free slots (4 max, 2 in use) but this user is
    // already at their per-user cap of 2 — must still be waiting.
    expect(thirdGranted).toBe(false);

    first.release();
    const thirdTicket = await third;
    expect(thirdGranted).toBe(true);
    second.release();
    thirdTicket.release();
  });

  it('(c) grants a queued high-priority job before an earlier-queued low-priority job', async () => {
    const holders = await Promise.all(
      Array.from({ length: 4 }, (_, i) => acquireRenderSlot({ pluginName: 'p-c', actor: user(`holder${i}`), priority: 'high', admissionControl: CONFIG })),
    );

    const order: string[] = [];
    const low = acquireRenderSlot({ pluginName: 'p-c', actor: user('low-user'), priority: 'low', admissionControl: CONFIG }).then((t) => {
      order.push('low');
      return t;
    });
    // Queued strictly after `low`, but higher priority — must still win.
    const high = acquireRenderSlot({ pluginName: 'p-c', actor: user('high-user'), priority: 'high', admissionControl: CONFIG }).then((t) => {
      order.push('high');
      return t;
    });
    await Promise.resolve();
    await Promise.resolve();

    // Free exactly one slot — only one of {low, high} can be granted.
    holders[0].release();
    await Promise.race([high, new Promise((r) => setTimeout(r, 0))]);
    expect(order).toEqual(['high']);

    holders[1].release();
    await low;
    expect(order).toEqual(['high', 'low']);

    holders[2].release();
    holders[3].release();
    (await high).release();
    (await low).release();
  });

  it('(d) rejects immediately once the wait queue reaches queueDepth, without waiting', async () => {
    const tinyConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 1 };
    const holder = await acquireRenderSlot({ pluginName: 'p-d', actor: user('holder'), priority: 'high', admissionControl: tinyConfig });
    // Fills the single queue slot (never resolved/rejected in this test — released at the end).
    const queued = acquireRenderSlot({ pluginName: 'p-d', actor: user('queued'), priority: 'high', admissionControl: tinyConfig });

    await expect(acquireRenderSlot({ pluginName: 'p-d', actor: user('overflow'), priority: 'high', admissionControl: tinyConfig })).rejects.toBeInstanceOf(
      RenderAdmissionQueueOverflowError,
    );

    holder.release();
    (await queued).release();
  });

  it('(e) removes a queued job from the queue and releases its per-user slot when its signal aborts', async () => {
    const config = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 200 };
    const holder = await acquireRenderSlot({ pluginName: 'p-e', actor: user('u1'), priority: 'high', admissionControl: config });

    const controller = new AbortController();
    const queuedPromise = acquireRenderSlot({ pluginName: 'p-e', actor: user('u2'), priority: 'low', admissionControl: config, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(queuedPromise).rejects.toBeInstanceOf(RenderAdmissionAbortedError);

    // The aborted job must be gone from the queue — a fresh request from
    // a *different* user should be grantable the instant the slot frees,
    // with no leftover phantom queue entry ahead of it.
    let granted = false;
    const next = acquireRenderSlot({ pluginName: 'p-e', actor: user('u3'), priority: 'low', admissionControl: config }).then((t) => {
      granted = true;
      return t;
    });
    holder.release();
    const ticket = await next;
    expect(granted).toBe(true);
    ticket.release();
  });

  it('(e) rejects synchronously when signal is already aborted before queueing', async () => {
    const config = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 200 };
    const holder = await acquireRenderSlot({ pluginName: 'p-e2', actor: user('u1'), priority: 'high', admissionControl: config });
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireRenderSlot({ pluginName: 'p-e2', actor: user('u2'), priority: 'low', admissionControl: config, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RenderAdmissionAbortedError);
    holder.release();
  });

  it('(e) rejects an already-aborted signal even when a slot is immediately available, without consuming it', async () => {
    const config = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 200 };
    const controller = new AbortController();
    controller.abort();

    // The pool is empty (no holders) — a slot is free right now. A naive
    // "grant first, only check signal for the queued path" implementation
    // would hand this an immediate ticket instead of rejecting it.
    await expect(
      acquireRenderSlot({ pluginName: 'p-e3', actor: user('u1'), priority: 'high', admissionControl: config, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RenderAdmissionAbortedError);

    // Proves the aborted request never actually consumed the single global
    // slot: a fresh, non-aborted request from a different user must still
    // find it free and be granted immediately (not queued).
    let granted = false;
    const ticketPromise = acquireRenderSlot({ pluginName: 'p-e3', actor: user('u2'), priority: 'high', admissionControl: config }).then((t) => {
      granted = true;
      return t;
    });
    await Promise.resolve();
    expect(granted).toBe(true);
    (await ticketPromise).release();
  });

  it('(f) two distinct users saturating their own quota do not affect each other’s remaining capacity', async () => {
    const config = { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 };
    // u1 takes both of its slots.
    const u1a = await acquireRenderSlot({ pluginName: 'p-f', actor: user('u1'), priority: 'high', admissionControl: config });
    const u1b = await acquireRenderSlot({ pluginName: 'p-f', actor: user('u1'), priority: 'high', admissionControl: config });
    // u1's 3rd request queues (per-user cap reached).
    let u1cGranted = false;
    const u1c = acquireRenderSlot({ pluginName: 'p-f', actor: user('u1'), priority: 'high', admissionControl: config }).then((t) => {
      u1cGranted = true;
      return t;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(u1cGranted).toBe(false);

    // u2's 2 requests must both be granted immediately — u1's queued 3rd
    // request must not consume u2's quota or block u2 in any way.
    const u2a = await acquireRenderSlot({ pluginName: 'p-f', actor: user('u2'), priority: 'high', admissionControl: config });
    const u2b = await acquireRenderSlot({ pluginName: 'p-f', actor: user('u2'), priority: 'high', admissionControl: config });
    expect(u1cGranted).toBe(false); // still queued — global pool now fully occupied (2 + 2)

    u1a.release();
    const u1cTicket = await u1c;
    expect(u1cGranted).toBe(true);

    u1b.release();
    u1cTicket.release();
    u2a.release();
    u2b.release();
  });

  it('non-"user" actors are not subject to the per-user cap (only the global cap applies)', async () => {
    const config = { maxConcurrentGlobal: 2, maxConcurrentPerUser: 1, queueDepth: 200 };
    const first = await acquireRenderSlot({ pluginName: 'p-anon', actor: { kind: 'anonymous' }, priority: 'high', admissionControl: config });
    const second = await acquireRenderSlot({ pluginName: 'p-anon', actor: { kind: 'system' }, priority: 'high', admissionControl: config });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    first.release();
    second.release();
  });

  it('release() is idempotent — calling it twice does not double-free capacity', async () => {
    const config = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 200 };
    const ticket = await acquireRenderSlot({ pluginName: 'p-idem', actor: user('u1'), priority: 'high', admissionControl: config });
    ticket.release();
    ticket.release();

    const t2 = await acquireRenderSlot({ pluginName: 'p-idem', actor: user('u2'), priority: 'high', admissionControl: config });
    let t3Granted = false;
    const t3 = acquireRenderSlot({ pluginName: 'p-idem', actor: user('u3'), priority: 'high', admissionControl: config }).then((t) => {
      t3Granted = true;
      return t;
    });
    await Promise.resolve();
    await Promise.resolve();
    // Only 1 global slot: t2 holds it, t3 must still be queued (proves
    // the double-release above did not leave the pool at capacity -1).
    expect(t3Granted).toBe(false);
    t2.release();
    (await t3).release();
  });
});
