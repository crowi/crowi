/**
 * Deterministic coverage for `failure-taxonomy-reporter.js`
 * (feature-flake-failure-taxonomy AC-1): pass/non-pass classification (a
 * worker-crash `TestResult` — `testExecError` set, `testResults: []` — is
 * NOT the same as a genuine pass), worker-crash message sub-classification,
 * and the reporter's real `onTestResult` writing exactly one authoritative
 * record per non-pass file to the channel.
 *
 * `failure-taxonomy-reporter.js` / `failure-taxonomy-channel.js` are plain
 * CJS with no type declarations — required directly rather than imported
 * (same pattern as `crowi-environment.test.ts`).
 */
import { randomUUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const FailureTaxonomyReporter = require('./failure-taxonomy-reporter');
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const channel = require('./failure-taxonomy-channel') as {
  RUN_ID_ENV_VAR: string;
  readChannel: (runId: string) => { records: Array<Record<string, unknown>> };
  cleanupChannel: (runId: string) => void;
};

const { classifyExecError, isPass, recordIfNonPass, excerpt } = FailureTaxonomyReporter.__test__ as {
  classifyExecError: (message: string | undefined) => { kind: string; signal: string | null; exitCode: number | null };
  isPass: (testResult: Record<string, unknown>) => boolean;
  recordIfNonPass: (runId: string, testResult: Record<string, unknown>) => void;
  excerpt: (message: string | null | undefined) => string | null;
};

function passingTestResult(overrides: Record<string, unknown> = {}) {
  return {
    testFilePath: 'src/hono/handlers/example.test.ts',
    numFailingTests: 0,
    numPassingTests: 3,
    testResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }],
    testExecError: undefined,
    failureMessage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isPass
// ---------------------------------------------------------------------------

describe('isPass', () => {
  it('is true for a genuine pass (no exec error, zero failing, at least one per-test result)', () => {
    expect(isPass(passingTestResult())).toBe(true);
  });

  it('is false when numFailingTests > 0', () => {
    expect(isPass(passingTestResult({ numFailingTests: 1 }))).toBe(false);
  });

  it('is false for a worker-crash-shaped result (testExecError set, testResults empty, numFailingTests: 0) — NOT the same as a genuine pass', () => {
    const crashResult = passingTestResult({
      testResults: [],
      testExecError: { message: 'A jest worker process (pid=123) was terminated by another process: signal=SIGSEGV, exitCode=null.' },
    });
    expect(isPass(crashResult)).toBe(false);
  });

  it('is false when testResults is empty even without an exec error (defensive — "must contain at least one test" jest failure shape)', () => {
    expect(isPass(passingTestResult({ testResults: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyExecError
// ---------------------------------------------------------------------------

describe('classifyExecError', () => {
  it('classifies the "terminated by another process: signal=X" shape (SIGSEGV etc.)', () => {
    const result = classifyExecError('A jest worker process (pid=456) was terminated by another process: signal=SIGSEGV, exitCode=null.');
    expect(result).toEqual({ kind: 'worker-terminated', signal: 'SIGSEGV', exitCode: null });
  });

  it('classifies the "terminated by another process" shape with a numeric exit code', () => {
    const result = classifyExecError('A jest worker process (pid=456) was terminated by another process: signal=SIGKILL, exitCode=137.');
    expect(result).toEqual({ kind: 'worker-terminated', signal: 'SIGKILL', exitCode: 137 });
  });

  it('classifies the "crashed for an unknown reason" shape (no signal observable)', () => {
    const result = classifyExecError('A jest worker process (pid=789) crashed for an unknown reason: exitCode=1');
    expect(result).toEqual({ kind: 'worker-crashed', signal: null, exitCode: 1 });
  });

  it('classifies the out-of-memory shape', () => {
    const result = classifyExecError('Jest worker ran out of memory and crashed');
    expect(result).toEqual({ kind: 'worker-oom', signal: null, exitCode: null });
  });

  it('falls back to a generic exec-error classification for any other message (still counted as hasExecError by the caller)', () => {
    const result = classifyExecError('SyntaxError: Unexpected token');
    expect(result).toEqual({ kind: 'exec-error', signal: null, exitCode: null });
  });

  it('is defensive against a non-string message', () => {
    expect(classifyExecError(undefined)).toEqual({ kind: 'exec-error', signal: null, exitCode: null });
  });
});

// ---------------------------------------------------------------------------
// excerpt
// ---------------------------------------------------------------------------

describe('excerpt', () => {
  it('returns the message unchanged when short', () => {
    expect(excerpt('boom')).toBe('boom');
  });

  it('truncates a long message', () => {
    const long = 'x'.repeat(3000);
    const result = excerpt(long);
    expect(result?.length).toBeLessThan(long.length);
    expect(result?.endsWith('… (truncated)')).toBe(true);
  });

  it('returns null for a non-string input', () => {
    expect(excerpt(null)).toBeNull();
    expect(excerpt(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordIfNonPass — real channel I/O
// ---------------------------------------------------------------------------

describe('recordIfNonPass', () => {
  function freshRunId(): string {
    return `failure-taxonomy-reporter-test-${randomUUID()}`;
  }

  it('does nothing for a genuine pass', () => {
    const runId = freshRunId();
    recordIfNonPass(runId, passingTestResult());
    const { records } = channel.readChannel(runId);
    expect(records).toEqual([]);
  });

  it('records an authoritative-file-result for a per-assertion failure', () => {
    const runId = freshRunId();
    try {
      recordIfNonPass(
        runId,
        passingTestResult({
          numFailingTests: 1,
          numPassingTests: 2,
          failureMessage: 'expect(received).toBe(expected)',
        }),
      );
      const { records } = channel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'authoritative-file-result',
        testFilePath: 'src/hono/handlers/example.test.ts',
        numFailingTests: 1,
        hasExecError: false,
        workerCrash: null,
      });
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('records a worker-crash record (SIGSEGV) with numFailingTests: 0 and an empty assertion count — the "signal or missing result" case AC-1 requires', () => {
    const runId = freshRunId();
    try {
      recordIfNonPass(
        runId,
        passingTestResult({
          testResults: [],
          numFailingTests: 0,
          numPassingTests: 0,
          testExecError: {
            name: 'Error',
            message: 'A jest worker process (pid=123) was terminated by another process: signal=SIGSEGV, exitCode=null.',
          },
        }),
      );
      const { records } = channel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'authoritative-file-result',
        hasExecError: true,
        numFailingTests: 0,
        numAssertionResults: 0,
        workerCrash: { kind: 'worker-terminated', signal: 'SIGSEGV', exitCode: null },
      });
    } finally {
      channel.cleanupChannel(runId);
    }
  });
});

// ---------------------------------------------------------------------------
// FailureTaxonomyReporter (real jest Reporter instance)
// ---------------------------------------------------------------------------

describe('FailureTaxonomyReporter', () => {
  const originalEnv = process.env[channel.RUN_ID_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[channel.RUN_ID_ENV_VAR];
    else process.env[channel.RUN_ID_ENV_VAR] = originalEnv;
  });

  it('establishes its own run id in the constructor and records only non-pass files via onTestResult', () => {
    delete process.env[channel.RUN_ID_ENV_VAR];
    const reporter = new FailureTaxonomyReporter();
    const runId = process.env[channel.RUN_ID_ENV_VAR];
    expect(typeof runId).toBe('string');

    try {
      reporter.onTestResult(undefined, passingTestResult());
      reporter.onTestResult(undefined, passingTestResult({ testFilePath: 'src/hono/handlers/broken.test.ts', numFailingTests: 1 }));

      const { records } = channel.readChannel(runId as string);
      expect(records).toHaveLength(1);
      expect(records[0].testFilePath).toBe('src/hono/handlers/broken.test.ts');
    } finally {
      channel.cleanupChannel(runId as string);
    }
  });

  it('does not throw when onRunComplete runs after a fresh (never-written) run', () => {
    delete process.env[channel.RUN_ID_ENV_VAR];
    const reporter = new FailureTaxonomyReporter();
    expect(() => reporter.onRunComplete()).not.toThrow();
  });
});
