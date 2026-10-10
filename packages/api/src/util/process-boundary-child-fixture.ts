/**
 * RFC-0025 process-boundary — a standalone child-process fixture that
 * triggers exactly ONE `uncaughtException` or `unhandledRejection` through
 * the REAL `installProcessFatalHandlers()` wiring and a REAL, functioning
 * fatal sink (real `fs.writeSync` on the real stderr fd, real
 * `process.exit`), so `process-boundary.unit.test.ts`'s child-process cases
 * can observe genuine process exit codes and genuine physical stderr bytes
 * — none of which an in-process, mocked-sink test can prove.
 *
 * Run via `tsx` (`process.execPath --import <tsx loader path>
 * process-boundary-child-fixture.ts`), the same approach as
 * `rebuild-attachment-display-derivatives-sigint-harness.ts` /
 * `collab/redis-smoke-harness.ts`, so it is a genuinely separate OS
 * process. `runFatalChild` (`process-boundary.unit.test.ts`) always spawns
 * with `cwd` fixed to `packages/api` — this file does not depend on that
 * for its OWN resolution, since every same-package runtime import below is
 * a RELATIVE specifier, never the `src/...` bare-specifier alias every
 * ts-jest / `tsc`+`tsc-alias`-built file in this package otherwise uses.
 * Plain `tsx` invoked this way resolves relative imports with no alias
 * step at all, so this file needs none.
 *
 * Protocol (env vars):
 *   - `CROWI_PROCESS_BOUNDARY_FIXTURE_MODE` — `"exception"` (throw from a
 *     macrotask, so it becomes a genuine `uncaughtException` rather than a
 *     synchronous throw before handlers are installed) or `"rejection"`
 *     (an unhandled `Promise.reject(...)` from a macrotask).
 *   - `CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE` — `"error"` (a plain `Error`),
 *     `"string"` (a plain string), or one of `"fault:proxy"` /
 *     `"fault:accessor"` / `"fault:symbol"` (the three reason-derivation
 *     faults — see `createFailureReasonFault` below).
 *   - `CROWI_PROCESS_BOUNDARY_FIXTURE_BREAK_TIMESTAMP` — when `"1"`,
 *     installs a one-shot `Date.prototype.toISOString` fault
 *     (`installOneShotTimestampFault`) before triggering the failure, so
 *     the record factory itself fails and the reduced-record path
 *     is exercised.
 *
 * Output protocol: each fault hook, if ever actually invoked, synchronously
 * writes `HOOK_MARKER_PREFIX<mode>\n` to stdout BEFORE doing anything else
 * (throwing, for the proxy and accessor faults; blocking forever, for the
 * `Symbol.toPrimitive` fault — see `createFailureReasonFault`'s doc comment
 * for why that one is genuinely non-returning here, unlike the in-process
 * double of the same name in `test/process-fatal-test-doubles.ts`). The
 * parent treats an absent marker as "the hook was never called" and its own
 * spawn deadline as the failure signal for a mistakenly-invoked
 * `Symbol.toPrimitive` hook.
 */
import { installProcessFatalHandlers } from './process-boundary';

type ProcessBoundaryFixtureMode = 'exception' | 'rejection';
type FailureReasonFaultMode = 'proxy-get-prototype-of' | 'error-message-accessor' | 'symbol-to-primitive';

const HOOK_MARKER_PREFIX = '@@process-boundary-fixture:hook-invoked ';

/**
 * One of the three reason-derivation faults (a `Proxy` whose
 * `getPrototypeOf` trap fires, an Error whose `message` is an accessor, an
 * object with a `Symbol.toPrimitive` hook), as a value whose fault hook — if
 * the process boundary's reason derivation ever mistakenly touches it — is
 * observable from the OUTSIDE (a stdout marker) instead of silently
 * succeeding with a wrong-but-quiet result. The `Symbol.toPrimitive` hook is
 * genuinely non-returning (an infinite loop) because that is the only way
 * to prove "never touched" for a hook whose entire hazard IS that it never
 * returns; `runFatalChild`'s own deadline (never an in-process Jest timer,
 * which cannot fire while this same thread spins) is what turns a mistaken
 * invocation into a failing test instead of a hang.
 */
function createFailureReasonFault(mode: FailureReasonFaultMode): unknown {
  const markHookInvoked = (): void => {
    process.stdout.write(`${HOOK_MARKER_PREFIX}${mode}\n`);
  };

  if (mode === 'proxy-get-prototype-of') {
    return new Proxy(
      {},
      {
        getPrototypeOf() {
          markHookInvoked();
          throw new Error(`process-boundary-child-fixture: ${mode} hook invoked`);
        },
      },
    );
  }

  if (mode === 'error-message-accessor') {
    const err = new Error('unused — replaced by the accessor below');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        markHookInvoked();
        throw new Error(`process-boundary-child-fixture: ${mode} hook invoked`);
      },
    });
    return err;
  }

  return {
    [Symbol.toPrimitive]() {
      markHookInvoked();
      // Deliberately never returns — see this function's doc comment.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // spin
      }
    },
  };
}

/**
 * Fault-injects `Date.prototype.toISOString` for exactly the NEXT call,
 * then restores the original before throwing — so only the record
 * factory's own per-record timestamp call fails, never a later, unrelated
 * caller in the same process (e.g. a `Date` used inside error formatting
 * after the fault fires).
 */
function installOneShotTimestampFault(): void {
  const original = Date.prototype.toISOString;
  Date.prototype.toISOString = function toISOStringFault(this: Date): string {
    Date.prototype.toISOString = original;
    throw new Error('process-boundary-child-fixture: timestamp formatter fault');
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`process-boundary-child-fixture: required env var ${name} is not set`);
  }
  return value;
}

function resolveTriggerValue(): unknown {
  const valueMode = requiredEnv('CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE');
  switch (valueMode) {
    case 'error':
      return new Error('process-boundary-child-fixture: triggered error');
    case 'string':
      return 'process-boundary-child-fixture: triggered plain string';
    case 'fault:proxy':
      return createFailureReasonFault('proxy-get-prototype-of');
    case 'fault:accessor':
      return createFailureReasonFault('error-message-accessor');
    case 'fault:symbol':
      return createFailureReasonFault('symbol-to-primitive');
    default:
      throw new Error(`process-boundary-child-fixture: unknown CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE ${valueMode}`);
  }
}

function triggerProcessBoundaryFailure(): void {
  installProcessFatalHandlers();

  if (process.env.CROWI_PROCESS_BOUNDARY_FIXTURE_BREAK_TIMESTAMP === '1') {
    installOneShotTimestampFault();
  }

  const mode = requiredEnv('CROWI_PROCESS_BOUNDARY_FIXTURE_MODE') as ProcessBoundaryFixtureMode;
  const value = resolveTriggerValue();

  if (mode === 'exception') {
    // A macrotask (not a synchronous top-level throw) — genuinely reaches
    // Node's `uncaughtException` dispatch instead of unwinding this
    // module's own top-level evaluation.
    setTimeout(() => {
      throw value;
    }, 0);
    return;
  }

  if (mode === 'rejection') {
    setTimeout(() => {
      void Promise.reject(value);
    }, 0);
    return;
  }

  throw new Error(`process-boundary-child-fixture: unknown CROWI_PROCESS_BOUNDARY_FIXTURE_MODE ${mode}`);
}

triggerProcessBoundaryFailure();
