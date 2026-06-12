import { crowi } from 'src/test/setup';

/**
 * Unit coverage for the fire-and-forget side-effect drain primitive
 * (`crowi.trackSideEffect` / `crowi.drainSideEffects`). This is the one new
 * test the flake-hardening spec adds on purpose (it is an acceptance
 * criterion): the rest of the work is harness/teardown hardening, not new
 * coverage.
 *
 * We drive the primitive with hand-built deferred promises so the test is
 * deterministic and never touches Mongo/redis — it asserts the drain
 * *mechanism*, not any particular side effect.
 */
describe('crowi.drainSideEffects', () => {
  // Manually-resolvable promise so we control exactly when a side effect
  // settles relative to the drain.
  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test('resolves immediately when there are no in-flight side effects', async () => {
    await expect(crowi.drainSideEffects()).resolves.toBeUndefined();
  });

  test('waits for a tracked in-flight side effect to settle', async () => {
    const d = deferred();
    let settled = false;
    crowi.trackSideEffect(d.promise.then(() => void (settled = true)));

    const drain = crowi.drainSideEffects();

    // Drain must still be pending while the side effect is in flight.
    let drainResolved = false;
    void drain.then(() => void (drainResolved = true));
    await Promise.resolve();
    expect(drainResolved).toBe(false);
    expect(settled).toBe(false);

    d.resolve();
    await drain;
    expect(settled).toBe(true);
  });

  test('a rejected side effect still lets the drain resolve (errors not re-thrown)', async () => {
    const d = deferred();
    // Attach the same kind of `.catch` the real call sites keep, so this
    // does not become an unhandled rejection.
    crowi.trackSideEffect(d.promise.catch(() => {}));

    const drain = crowi.drainSideEffects();
    d.reject(new Error('boom'));
    await expect(drain).resolves.toBeUndefined();
  });

  test('waits for second-level side effects added while draining (nested)', async () => {
    const first = deferred();
    const second = deferred();
    let secondSettled = false;

    // The first side effect, on settle, spawns a second one — mirroring
    // Activity post('save') → Notification fan-out and userEvent
    // 'activated' → page re-emit.
    crowi.trackSideEffect(
      first.promise.then(() => {
        crowi.trackSideEffect(second.promise.then(() => void (secondSettled = true)));
      }),
    );

    const drain = crowi.drainSideEffects();
    let drainResolved = false;
    void drain.then(() => void (drainResolved = true));

    first.resolve();
    // Let the first settle and register the second; drain must not resolve
    // yet because the nested effect is now in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(drainResolved).toBe(false);
    expect(secondSettled).toBe(false);

    second.resolve();
    await drain;
    expect(secondSettled).toBe(true);
  });
});
