import { getRequestScope, runWithRequestScope } from './request-scope';

/**
 * Pure `AsyncLocalStorage` wrapper — no Crowi/Mongo/Hono boot (unit project,
 * brief §9.2). AC-C06.
 */
describe('request scope', () => {
  it('isolates immediate promise nested rejected and barrier-interleaved scopes', async () => {
    expect(getRequestScope()).toBeUndefined();

    // Immediate value.
    const immediate = runWithRequestScope({ requestId: 'req-1' }, () => getRequestScope()?.requestId);
    expect(immediate).toBe('req-1');
    expect(getRequestScope()).toBeUndefined();

    // Promise-returning callback: the scope must still be visible after an await inside it.
    const promiseResult = await runWithRequestScope({ requestId: 'req-2' }, async () => {
      await Promise.resolve();
      return getRequestScope()?.requestId;
    });
    expect(promiseResult).toBe('req-2');
    expect(getRequestScope()).toBeUndefined();

    // Nested scopes: inner shadows outer, outer resumes after inner returns.
    runWithRequestScope({ requestId: 'outer' }, () => {
      expect(getRequestScope()?.requestId).toBe('outer');
      runWithRequestScope({ requestId: 'inner' }, () => {
        expect(getRequestScope()?.requestId).toBe('inner');
      });
      expect(getRequestScope()?.requestId).toBe('outer');
    });

    // Throwing callback: the scope propagates the throw unchanged and does not leak.
    expect(() =>
      runWithRequestScope({ requestId: 'throws' }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getRequestScope()).toBeUndefined();

    // Rejecting async callback: same, for the promise path.
    await expect(
      runWithRequestScope({ requestId: 'rejects' }, async () => {
        await Promise.resolve();
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
    expect(getRequestScope()).toBeUndefined();

    // Overlapping/concurrent executions interleaved through a barrier must not cross-contaminate.
    let releaseA: (() => void) | undefined;
    const barrierA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const taskA = runWithRequestScope({ requestId: 'concurrent-a' }, async () => {
      await barrierA;
      return getRequestScope()?.requestId;
    });
    const taskB = runWithRequestScope({ requestId: 'concurrent-b' }, async () => {
      return getRequestScope()?.requestId;
    });
    const resultB = await taskB;
    releaseA?.();
    const resultA = await taskA;
    expect(resultA).toBe('concurrent-a');
    expect(resultB).toBe('concurrent-b');
  });
});
