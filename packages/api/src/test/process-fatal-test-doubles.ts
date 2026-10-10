/**
 * Shared in-process test doubles for RFC-0025 process-boundary fatal-path
 * coverage, used by both `util/process-boundary.unit.test.ts`'s in-process
 * cases and `crowi/index.test.ts`'s `exitOnError` cases. Pure and
 * side-effect-free at module scope (no `jest.mock`/`jest.doMock`, no import
 * of `./logger`, `./logger-sink`, or `src/crowi`), so importing it never
 * changes what either test file's module isolation observes.
 */

/**
 * The three reason-derivation faults as an IN-PROCESS double: unlike the
 * child fixture's (`util/process-boundary-child-fixture.ts`)
 * genuinely-non-returning `Symbol.toPrimitive` hook, every hook here
 * records its own invocation and throws a distinctive sentinel immediately
 * — the reason derivation never touches any of them in a correct
 * implementation, so `hookCalls()` staying `0` is the assertion;
 * if the implementation ever DID call one, the sentinel fails the case
 * immediately instead of hanging (no in-process timer could fire while a
 * genuinely non-returning hook spins).
 */
export type FailureReasonFaultMode = 'proxy-get-prototype-of' | 'error-message-accessor' | 'symbol-to-primitive';

export class FailureReasonFaultHookInvoked extends Error {
  constructor(public readonly mode: FailureReasonFaultMode) {
    super(`process boundary test: reason-derivation hook invoked for fault mode "${mode}"`);
    this.name = 'FailureReasonFaultHookInvoked';
  }
}

export function createFailureReasonFault(mode: FailureReasonFaultMode): { value: unknown; hookCalls: () => number } {
  let calls = 0;
  const trip = (): never => {
    calls += 1;
    throw new FailureReasonFaultHookInvoked(mode);
  };
  let value: unknown;
  if (mode === 'proxy-get-prototype-of') {
    value = new Proxy({}, { getPrototypeOf: trip });
  } else if (mode === 'error-message-accessor') {
    const err = new Error('unused — replaced by the accessor below');
    Object.defineProperty(err, 'message', { configurable: true, get: trip });
    value = err;
  } else {
    value = { [Symbol.toPrimitive]: trip };
  }
  return { value, hookCalls: () => calls };
}

/** Fires on the NEXT `Date.prototype.toISOString()` call only, self-restoring before it throws. */
export function installOneShotTimestampFaultSpy(): void {
  const spy = jest.spyOn(Date.prototype, 'toISOString').mockImplementation(function toISOStringFault(this: Date) {
    spy.mockRestore();
    throw new Error('process boundary test: timestamp formatter fault');
  });
}

/**
 * Thrown by a mocked `writeFatal` in place of a real, non-returning fatal
 * write (`process.exit(1)`), so a case can assert "the fatal handoff was
 * reached exactly once" via `toThrow(FatalWriteSentinel)` without a real
 * process exit tearing down the Jest worker.
 */
export class FatalWriteSentinel extends Error {
  constructor(public readonly record: unknown) {
    super('process boundary test sentinel: fatal write reached (represents process.exit(1))');
    this.name = 'FatalWriteSentinel';
  }
}
