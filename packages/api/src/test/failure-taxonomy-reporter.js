const channel = require('./failure-taxonomy-channel');

// Parent-process custom Jest reporter — the AUTHORITATIVE per-file failure
// recorder for the flake taxonomy measurement pipeline
// (feature-flake-failure-taxonomy AC-1).
//
// ── Why the parent-process reporter, not a worker-side hook, is authoritative ──
//
// `packages/api/jest.config.js`'s `server` project registers this class via
// `reporters: ['default', './src/test/failure-taxonomy-reporter.js']`. Jest
// constructs every configured reporter (default AND custom) inside
// `@jest/core`'s `createTestScheduler()`, which `runJest.js` calls strictly
// AFTER `globalSetup` completes and strictly BEFORE `scheduler.scheduleTests()`
// — the call that later forks jest workers (`jest-runner`'s `new Worker(...)`,
// itself gated behind `TestScheduler.scheduleTests()`, never `createTestScheduler()`).
// So this reporter's constructor always runs in the jest MAIN process, before
// any worker exists — the same timing guarantee `global-setup.js` relies on
// for `CROWI_TEST_RUN_ID` (see `failure-taxonomy-channel.js`'s `ensureRunId()`
// doc comment).
//
// When a jest worker process crashes (e.g. the `SIGSEGV` this feature exists
// to catch), `jest-worker`'s `ChildProcessWorker._onExit` rejects the
// in-flight `worker.worker(...)` promise with an `Error` whose message is
// exactly `A jest worker process (pid=<pid>) was terminated by another
// process: signal=<signal>, exitCode=<exitCode>.` (or, when no signal is
// observable, `... crashed for an unknown reason: exitCode=<exitCode>`) — see
// `jest-worker@29.7.0`'s `build/workers/ChildProcessWorker.js`. `jest-runner`
// turns that rejection into a `'test-file-failure'` event
// (`build/index.js`'s `runTestInWorker`), which `@jest/core`'s
// `TestScheduler.scheduleTests()` routes through its `onFailure` callback:
// `buildFailureTestResult(test.path, error)` (`@jest/test-result`) produces a
// `TestResult` with `testExecError` set to that error, `testResults: []`
// (empty — no per-test results were ever produced) and `numFailingTests: 0`
// — this is the "signal or 欠落結果 (missing result)" AC-1 asks for: a file
// whose worker died mid-run is UNAMBIGUOUSLY distinguishable from a file that
// simply had zero failing tests (which always has `testResults.length > 0`
// and no `testExecError`). That `TestResult` is dispatched to every
// registered reporter's `onTestFileResult` (falling back to `onTestResult`,
// which is all this class implements — see `@jest/core`'s
// `ReporterDispatcher.onTestFileResult`) EXACTLY the same way a normal
// pass/fail result is — so `onTestResult` below is the single, uniform
// capture point for every non-pass outcome, worker-crash or not.
//
// Fail-open (AC-1: "計測失敗がテストを落とさない"): every code path below is
// wrapped so a bug or I/O failure in THIS reporter can never throw back into
// jest's own run loop and abort (or otherwise affect) the real test run —
// only ever `console.warn`.

const EXCERPT_MAX_LENGTH = 2000;

function excerpt(message) {
  if (typeof message !== 'string') return null;
  return message.length > EXCERPT_MAX_LENGTH ? `${message.slice(0, EXCERPT_MAX_LENGTH)}… (truncated)` : message;
}

// The exact two message shapes `ChildProcessWorker._onExit` produces for a
// worker that died with a pending request (see this file's top doc comment).
// `WORKER_OOM_PATTERN` matches the separate out-of-memory path in the same
// function (`workerIdleMemoryLimit` exceeded).
const WORKER_TERMINATED_PATTERN = /terminated by another process: signal=(\w+), exitCode=(-?\d+|null)/;
const WORKER_CRASHED_PATTERN = /crashed for an unknown reason: exitCode=(-?\d+|null)/;
const WORKER_OOM_PATTERN = /ran out of memory and crashed/;

/**
 * Sub-classifies a `testExecError`'s message into the worker-crash shapes
 * jest itself is known to produce, WITHOUT requiring a match: a `testExecError`
 * with `testResults: []` is ALREADY sufficient evidence of a missing result
 * (AC-1's "欠落結果") even when the message matches none of these patterns
 * (e.g. a syntax error that fails the whole file before any worker fork is
 * even involved) — `recordIfNonPass` records `hasExecError: true` regardless;
 * this function only enriches the record with a name for the common cases.
 */
function classifyExecError(message) {
  if (typeof message !== 'string') {
    return { kind: 'exec-error', signal: null, exitCode: null };
  }
  const terminated = message.match(WORKER_TERMINATED_PATTERN);
  if (terminated) {
    return { kind: 'worker-terminated', signal: terminated[1], exitCode: terminated[2] === 'null' ? null : Number(terminated[2]) };
  }
  const crashed = message.match(WORKER_CRASHED_PATTERN);
  if (crashed) {
    return { kind: 'worker-crashed', signal: null, exitCode: crashed[1] === 'null' ? null : Number(crashed[1]) };
  }
  if (WORKER_OOM_PATTERN.test(message)) {
    return { kind: 'worker-oom', signal: null, exitCode: null };
  }
  return { kind: 'exec-error', signal: null, exitCode: null };
}

/**
 * `true` iff `testResult` is a genuine pass: no exec error, zero failing
 * tests, AND at least one per-test result actually ran. The third condition
 * matters: a worker-crash `TestResult` also has `numFailingTests: 0`, but
 * `testResults: []` — an empty array, not "ran and all passed". Without it,
 * a crashed file would be silently treated as a pass instead of recorded.
 */
function isPass(testResult) {
  return !testResult.testExecError && testResult.numFailingTests === 0 && Array.isArray(testResult.testResults) && testResult.testResults.length > 0;
}

/** Appends one `kind: 'authoritative-file-result'` record for `testResult` — the caller has already checked `!isPass(testResult)`. Exported on `__test__` for direct coverage without constructing a fake jest run. */
function recordIfNonPass(runId, testResult) {
  if (isPass(testResult)) return;

  const execError = testResult.testExecError;
  const hasExecError = Boolean(execError);

  channel.appendRecord(runId, {
    kind: 'authoritative-file-result',
    testFilePath: testResult.testFilePath,
    numFailingTests: testResult.numFailingTests,
    numPassingTests: testResult.numPassingTests,
    numAssertionResults: Array.isArray(testResult.testResults) ? testResult.testResults.length : 0,
    hasExecError,
    execErrorName: hasExecError && execError.name ? execError.name : null,
    execErrorMessage: hasExecError ? excerpt(execError.message) : null,
    workerCrash: hasExecError ? classifyExecError(execError.message) : null,
    failureMessageExcerpt: excerpt(testResult.failureMessage),
  });
}

class FailureTaxonomyReporter {
  constructor() {
    this._nonPassCount = 0;
    try {
      this._runId = channel.ensureRunId();
    } catch (err) {
      console.warn(
        `[test-harness] failure-taxonomy-reporter: could not establish a run id — this run's authoritative failure records will not be captured (${err.message}).`,
      );
      this._runId = null;
    }
  }

  onTestResult(_test, testResult) {
    if (!this._runId) return;
    try {
      if (isPass(testResult)) return;
      recordIfNonPass(this._runId, testResult);
      this._nonPassCount += 1;
    } catch (err) {
      // Fail-open — see this file's top doc comment.
      console.warn(`[test-harness] failure-taxonomy-reporter: failed to record a result for ${testResult && testResult.testFilePath} (${err.message}).`);
    }
  }

  onRunComplete() {
    if (!this._runId || this._nonPassCount === 0) return;
    try {
      const { filePath } = channel.readChannel(this._runId);
      console.warn(
        `[test-harness] failure-taxonomy: recorded ${this._nonPassCount} non-pass file(s) for run ${this._runId} to ${filePath} ` +
          '(scripts/test-flake-taxonomy.mjs reads and cleans this up; a bare `pnpm test` leaves it in place).',
      );
    } catch {
      // Best-effort summary line only — never fail the run over it.
    }
  }
}

module.exports = FailureTaxonomyReporter;

// Test-only hooks — same pattern as `crowi-environment.js`'s `__test__`.
FailureTaxonomyReporter.__test__ = { classifyExecError, isPass, recordIfNonPass, excerpt };
