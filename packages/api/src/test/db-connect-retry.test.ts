/**
 * Deterministic fixtures for `db-connect-retry.ts` (feature-test-parallel-db-flake-hardening,
 * Phase 1 / A1-1). Runs inside the full per-file harness like every other
 * `src/**\/*.test.ts` file (its own `beforeAll` boots a real — or memory-server
 * — `Crowi`/Mongo via `setup.ts`), but every test below exercises the module
 * under test in isolation from that ambient connection: `mongoose.disconnect`
 * is always stubbed so it can never touch the file's real connection, and the
 * JSON Lines side channel is redirected to a per-test-unique
 * `CROWI_TEST_RUN_ID` so these tests never pollute (or race with) the
 * ambient run's real retry-events file.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

import mongoose from 'mongoose';

import {
  BACKOFF_MAX_MS,
  BEFORE_ALL_HOOK_TIMEOUT_MS,
  bootCrowiWithRetry,
  DRIVER_DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  isRetryableConnectFailure,
  MAX_CONNECT_ATTEMPTS,
  resolveRetryEventsPath,
} from './db-connect-retry';

const CONNECT_ERROR_PREFIX = 'Cannot connect to Database Server: ';

/** Mirrors `setupDatabase()`'s catch block: `new Error('Cannot connect to Database Server: ' + e.message, { cause: e })`. */
function wrapAsSetupDatabaseFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${CONNECT_ERROR_PREFIX}${message}`, { cause });
}

// ---------------------------------------------------------------------------
// isRetryableConnectFailure — classification
// ---------------------------------------------------------------------------

describe('isRetryableConnectFailure', () => {
  it('retries an errno-bearing error found inside a MongoServerSelectionError.reason.servers topology map', () => {
    const errnoErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'ECONNREFUSED' });
    const reason = { servers: new Map([['127.0.0.1:27017', { type: 'Unknown', error: errnoErr }]]) };
    const selectionErr = Object.assign(new Error('Server selection timed out after 30000 ms'), {
      name: 'MongoServerSelectionError',
      reason,
    });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(selectionErr))).toBe(true);
  });

  it('retries a directly-nested MongoNetworkTimeoutError (subclass of MongoNetworkError)', () => {
    const timeoutErr = Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(timeoutErr))).toBe(true);
  });

  it('retries a bare MongoNetworkError with no cause and no errno (socket closed mid-establishment)', () => {
    const bareNetworkErr = Object.assign(new Error('Socket closed after handshake initiation during connection establishment'), {
      name: 'MongoNetworkError',
    });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(bareNetworkErr))).toBe(true);
  });

  it('retries when the errno evidence is two cause-links deep', () => {
    const errnoErr = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const midErr = new Error('Client network socket disconnected before secure TLS connection was established', { cause: errnoErr });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(midErr))).toBe(true);
  });

  it('does NOT retry a MongoServerSelectionError whose reason carries only an auth failure (no errno / no MongoNetworkError evidence)', () => {
    const authErr = Object.assign(new Error('bad auth : Authentication failed'), { name: 'MongoServerError', code: 18 });
    const reason = { servers: new Map([['127.0.0.1:27017', { type: 'Unknown', error: authErr }]]) };
    const selectionErr = Object.assign(new Error('Server selection timed out after 30000 ms'), {
      name: 'MongoServerSelectionError',
      reason,
    });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(selectionErr))).toBe(false);
  });

  it('does NOT retry a MongooseServerSelectionError whose reason carries only an SSL-shaped failure', () => {
    const sslErr = Object.assign(new Error('unable to verify the first certificate'), { name: 'MongoServerError' });
    const reason = { servers: new Map([['127.0.0.1:27017', { type: 'Unknown', error: sslErr }]]) };
    const mongooseSelectionErr = Object.assign(new Error('unable to verify the first certificate'), {
      name: 'MongooseServerSelectionError',
      reason,
      cause: reason,
    });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(mongooseSelectionErr))).toBe(false);
  });

  it('does NOT retry a failure that never reached the setupDatabase() wrapper (e.g. a test assertion failure)', () => {
    expect(isRetryableConnectFailure(new Error('expect(received).toBe(expected)'))).toBe(false);
  });

  it('does NOT retry a setupDatabase() wrapper with no cause at all', () => {
    expect(isRetryableConnectFailure(new Error(`${CONNECT_ERROR_PREFIX}boom`))).toBe(false);
  });

  it('does NOT retry a setupDatabase() wrapper whose cause has no errno/name evidence (e.g. a malformed URI)', () => {
    const parseErr = Object.assign(new Error('Invalid connection string'), { name: 'MongoParseError' });
    expect(isRetryableConnectFailure(wrapAsSetupDatabaseFailure(parseErr))).toBe(false);
  });

  it('does NOT retry a non-Error value', () => {
    expect(isRetryableConnectFailure('not an error')).toBe(false);
    expect(isRetryableConnectFailure(null)).toBe(false);
    expect(isRetryableConnectFailure(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry budget vs. the beforeAll hook timeout (A1-1 acceptance criterion)
// ---------------------------------------------------------------------------

describe('retry budget', () => {
  it('fits inside the beforeAll hook timeout with room to spare for the rest of crowi.init()', () => {
    const worstCaseMs = MAX_CONNECT_ATTEMPTS * DRIVER_DEFAULT_SERVER_SELECTION_TIMEOUT_MS + BACKOFF_MAX_MS;
    expect(worstCaseMs).toBeLessThan(BEFORE_ALL_HOOK_TIMEOUT_MS);
    // Leaves comfortable headroom (not just "less than") for models/redis/
    // config/migrations/renderer/plugins/mailer to run after the connect step.
    expect(BEFORE_ALL_HOOK_TIMEOUT_MS - worstCaseMs).toBeGreaterThanOrEqual(20000);
  });
});

// ---------------------------------------------------------------------------
// bootCrowiWithRetry — retry loop mechanics
// ---------------------------------------------------------------------------

describe('bootCrowiWithRetry', () => {
  const originalRunId = process.env.CROWI_TEST_RUN_ID;

  beforeEach(() => {
    // A unique run id per test so the JSONL side channel never collides
    // with the ambient run's real file (shared across every worker/file in
    // this jest invocation) or with another test in this file.
    process.env.CROWI_TEST_RUN_ID = `db-connect-retry-test-${randomUUID()}`;
  });

  afterEach(() => {
    // Clean up this test's fake side-channel file BEFORE restoring
    // `CROWI_TEST_RUN_ID` — `resolveRetryEventsPath()` reads the env var at
    // call time, so it must still point at this test's fake run id here.
    // Restoring first (or leaving it un-restored) would either miss the
    // file or — worse — leak this test's fake run id into whatever the
    // next test file in this worker process boots (it would then write
    // real retry events to this test's already-deleted file instead of
    // the ambient run's actual side channel).
    try {
      rmSync(resolveRetryEventsPath(), { force: true });
    } catch {
      // best-effort cleanup
    }
    if (originalRunId === undefined) {
      delete process.env.CROWI_TEST_RUN_ID;
    } else {
      process.env.CROWI_TEST_RUN_ID = originalRunId;
    }
  });

  // Every retry-evidence variant `isRetryableConnectFailure` recognizes,
  // driven all the way through `bootCrowiWithRetry`'s retry loop
  // (build/disconnect/console.warn call counts) rather than only asserting
  // the boolean classification — AC7 requires the 4 retryable errnos
  // (ECONNREFUSED / ETIMEDOUT / ECONNRESET / EAI_AGAIN) AND the 2
  // name-based classes (bare `MongoNetworkError` / `MongoNetworkTimeoutError`)
  // each be exercised through the loop itself, not just through the
  // classifier (see `isRetryableConnectFailure` describe block above for
  // the classifier-only variants, including deeper cause-chain nesting).
  const RETRYABLE_EVIDENCE_VARIANTS: Array<[string, () => Error, string]> = [
    ['ETIMEDOUT errno', () => Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:27017'), { code: 'ETIMEDOUT' }), 'ETIMEDOUT'],
    ['ECONNREFUSED errno', () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    ['ECONNRESET errno', () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'ECONNRESET'],
    ['EAI_AGAIN errno', () => Object.assign(new Error('getaddrinfo EAI_AGAIN mongo'), { code: 'EAI_AGAIN' }), 'EAI_AGAIN'],
    [
      'bare MongoNetworkError (no cause, no errno — socket closed mid-establishment)',
      () => Object.assign(new Error('Socket closed after handshake initiation during connection establishment'), { name: 'MongoNetworkError' }),
      'MongoNetworkError',
    ],
    ['MongoNetworkTimeoutError', () => Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' }), 'MongoNetworkTimeoutError'],
  ];

  it.each(RETRYABLE_EVIDENCE_VARIANTS)('retries once on %s and succeeds on the second attempt', async (_label, buildCause, expectedErrnoOrClass) => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = wrapAsSetupDatabaseFailure(buildCause());

    let calls = 0;
    const build = jest.fn(() => {
      calls += 1;
      const attempt = calls;
      return {
        init: async () => {
          if (attempt === 1) throw failure;
        },
      };
    });

    const result = await bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts');

    expect(result).toBeDefined();
    expect(build).toHaveBeenCalledTimes(2);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining(`[test-harness] src/test/db-connect-retry.test.ts: DB connect attempt 1 failed (${expectedErrnoOrClass})`),
    );
  });

  it('gives up after MAX_CONNECT_ATTEMPTS and throws the last error, even if it is still classified retryable', async () => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errnoErr = Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:27017'), { code: 'ETIMEDOUT' });
    const failure = wrapAsSetupDatabaseFailure(errnoErr);

    const build = jest.fn(() => ({
      init: async () => {
        throw failure;
      },
    }));

    await expect(bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts')).rejects.toBe(failure);
    expect(build).toHaveBeenCalledTimes(MAX_CONNECT_ATTEMPTS);
    // Only ONE retry ever happens (2 attempts total), so disconnect fires once.
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('calls onInstanceCreated for every attempt, including the final one that throws — so a caller assigning its own binding there never ends up with an unassigned/undefined value on a fully-exhausted failure', async () => {
    // Regression coverage for the `setup.ts` `afterAll` bug: before this
    // callback existed, a caller that only did `crowi = await
    // bootCrowiWithRetry(...)` left `crowi` unassigned whenever every
    // attempt failed, so `afterAll`'s `crowi.drainSideEffects()` threw
    // `TypeError: Cannot read properties of undefined` and masked the real
    // connect failure instead of surfacing it.
    jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errnoErr = Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:27017'), { code: 'ETIMEDOUT' });
    const failure = wrapAsSetupDatabaseFailure(errnoErr);

    const instances: Array<{ id: number; init(): Promise<void> }> = [];
    let calls = 0;
    const build = jest.fn(() => {
      calls += 1;
      return {
        id: calls,
        init: async () => {
          throw failure;
        },
      };
    });

    let assigned: { id: number; init(): Promise<void> } | undefined;
    await expect(
      bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts', (instance) => {
        instances.push(instance);
        assigned = instance;
      }),
    ).rejects.toBe(failure);

    expect(instances).toHaveLength(MAX_CONNECT_ATTEMPTS);
    // The caller's binding was reassigned on every attempt, so after the
    // rejection it still points at the LAST (failed) attempt's instance —
    // never left `undefined`.
    expect(assigned).toBeDefined();
    expect(assigned?.id).toBe(MAX_CONNECT_ATTEMPTS);
  });

  it('does not retry a failure that never reached the setupDatabase() wrapper at all — condition (a) false — fails on the first attempt without disconnecting or building again', async () => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Deliberately UNWRAPPED (no `Cannot connect to Database Server:`
    // prefix) — e.g. a bug elsewhere in `crowi.init()`'s boot layers, or a
    // test-only failure unrelated to connecting at all.
    const unrelatedFailure = new Error('Authentication failed');

    const build = jest.fn(() => ({
      init: async () => {
        throw unrelatedFailure;
      },
    }));

    await expect(bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts')).rejects.toBe(unrelatedFailure);
    expect(build).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not retry a setupDatabase()-wrapped auth failure — condition (a) TRUE, (b) FALSE — fails on the first attempt without disconnecting or building again', async () => {
    // This is the important negative case AC1 calls out: a
    // `MongoServerSelectionError` whose reason chain carries only an auth
    // failure (no errno, no `MongoNetworkError`/`MongoNetworkTimeoutError`
    // name) IS a genuine `setupDatabase()` connect failure — condition (a)
    // is true, matching the exact prefix that proves `setupModels()` never
    // ran — but must still not be retried because condition (b) (transient
    // network evidence) is false. Retrying a permanent auth misconfig would
    // just burn the whole retry budget for the same deterministic failure.
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const authErr = Object.assign(new Error('bad auth : Authentication failed'), { name: 'MongoServerError', code: 18 });
    const reason = { servers: new Map([['127.0.0.1:27017', { type: 'Unknown', error: authErr }]]) };
    const selectionErr = Object.assign(new Error('Server selection timed out after 30000 ms'), {
      name: 'MongoServerSelectionError',
      reason,
    });
    const failure = wrapAsSetupDatabaseFailure(selectionErr);

    const build = jest.fn(() => ({
      init: async () => {
        throw failure;
      },
    }));

    await expect(bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts')).rejects.toBe(failure);
    expect(build).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not retry a setupDatabase()-wrapped MongoParseError (malformed connection string) — condition (a) TRUE, (b) FALSE — fails on the first attempt without disconnecting or building again', async () => {
    // Same fixture shape as the `isRetryableConnectFailure` classifier test
    // above ("...whose cause has no errno/name evidence (e.g. a malformed
    // URI)"), but driven all the way through `bootCrowiWithRetry`'s retry
    // loop rather than only asserting the boolean classification — AC7's
    // other missing negative case: a malformed connection string is a
    // genuine `setupDatabase()` connect failure (condition (a) true) but
    // carries no transient-network evidence (condition (b) false), so it
    // must fail immediately rather than burn the retry budget on a
    // deterministic misconfiguration.
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const parseErr = Object.assign(new Error('Invalid connection string'), { name: 'MongoParseError' });
    const failure = wrapAsSetupDatabaseFailure(parseErr);

    const build = jest.fn(() => ({
      init: async () => {
        throw failure;
      },
    }));

    await expect(bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts')).rejects.toBe(failure);
    expect(build).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves immediately (no retry machinery) when the first attempt succeeds', async () => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    const marker = { init: async () => {} };
    const build = jest.fn(() => marker);

    const result = await bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts');

    expect(result).toBe(marker);
    expect(build).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('appends one JSON Lines row (timestamp/testFilePath/attempt/errnoOrClass) per retry to the run-scoped side channel', async () => {
    jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const timeoutErr = Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' });
    const failure = wrapAsSetupDatabaseFailure(timeoutErr);

    let calls = 0;
    const build = jest.fn(() => {
      calls += 1;
      const attempt = calls;
      return {
        init: async () => {
          if (attempt === 1) throw failure;
        },
      };
    });

    await bootCrowiWithRetry(build, 'src/test/db-connect-retry.test.ts');

    const raw = readFileSync(resolveRetryEventsPath(), 'utf8').trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      testFilePath: 'src/test/db-connect-retry.test.ts',
      attempt: 1,
      errnoOrClass: 'MongoNetworkTimeoutError',
    });
    expect(typeof event.timestamp).toBe('string');
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveRetryEventsPath — loud failure on a broken harness (unset run id)
// ---------------------------------------------------------------------------

describe('resolveRetryEventsPath', () => {
  const originalRunId = process.env.CROWI_TEST_RUN_ID;

  afterEach(() => {
    if (originalRunId === undefined) {
      delete process.env.CROWI_TEST_RUN_ID;
    } else {
      process.env.CROWI_TEST_RUN_ID = originalRunId;
    }
  });

  it('throws a diagnostic error instead of silently falling back to a machine-shared path when CROWI_TEST_RUN_ID is unset', () => {
    delete process.env.CROWI_TEST_RUN_ID;
    expect(() => resolveRetryEventsPath()).toThrow(/CROWI_TEST_RUN_ID is unset/);
  });

  it('scopes the path by CROWI_TEST_RUN_ID', () => {
    process.env.CROWI_TEST_RUN_ID = 'abc123';
    expect(resolveRetryEventsPath().endsWith('crowi-api-test-retry-events.abc123.jsonl')).toBe(true);
  });
});
