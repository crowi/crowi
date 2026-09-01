// Parent-process Jest reporter that prints ONLY what a reader has to act on.
//
// It replaces `'default'` (which prints one `PASS <file>` line per test file —
// 220 of them here, about 40% of this suite's output — plus every passing
// file's buffered console). `'summary'` still supplies the run totals, and
// `failure-taxonomy-reporter.js` still records non-pass files; this class owns
// only the per-file output.
//
// What survives, and why:
//   - a failing file: its header, its buffered console, and the formatted
//     `failureMessage` — dropping any of these would mean re-running to learn
//     what broke, which costs more than it saves.
//   - a file whose tests were ALL skipped: one line naming it. A wholly
//     skipped file is coverage that silently went missing (here: an
//     env-gated suite whose service was not reachable), and the totals alone
//     cannot say WHICH file, so this is the thread to pull. Individual
//     `it.skip` inside an otherwise-running file is a deliberate authoring
//     choice and stays a number in the totals.
//   - a passing file: nothing at all. Suppressing its header also suppresses
//     its console, which is the point — a test that passes has nothing to say.
//
// Fail-open, for the same reason `failure-taxonomy-reporter.js` is: a defect
// in reporting must never turn a green run red. Every hook is wrapped, and a
// throw degrades to "print it anyway" rather than to silence, so the failure
// mode is noise rather than a hidden failure.
class FailuresOnlyReporter {
  constructor() {
    this._skippedFiles = [];
  }

  onTestResult(_test, testResult) {
    try {
      if (this._isNonPass(testResult)) {
        this._printNonPass(testResult);
        return;
      }
      if (this._isWhollySkipped(testResult)) {
        this._skippedFiles.push(testResult.testFilePath);
      }
    } catch {
      // Reporting is not allowed to decide the run's fate. Falling back to the
      // raw message keeps the operator strictly better off than silence.
      if (testResult && testResult.failureMessage) process.stdout.write(`${testResult.failureMessage}\n`);
    }
  }

  onRunComplete() {
    try {
      if (this._skippedFiles.length === 0) return;
      process.stdout.write(`\nSkipped in full (${this._skippedFiles.length}):\n`);
      for (const filePath of this._skippedFiles) process.stdout.write(`  ${filePath}\n`);
    } catch {
      /* see the fail-open note above */
    }
  }

  // `testExecError` is set when the file never produced per-test results at
  // all — a worker crash, or a throw while the module was being loaded. It has
  // to be checked separately: such a file reports zero failing TESTS.
  _isNonPass(testResult) {
    return testResult.numFailingTests > 0 || testResult.testExecError != null || Boolean(testResult.failureMessage);
  }

  _isWhollySkipped(testResult) {
    const ran = testResult.numPassingTests + testResult.numFailingTests;
    const deferred = testResult.numPendingTests + testResult.numTodoTests;
    return ran === 0 && deferred > 0;
  }

  _printNonPass(testResult) {
    process.stdout.write(`\nFAIL ${testResult.testFilePath}\n`);
    for (const entry of testResult.console ?? []) {
      process.stdout.write(`  console.${entry.type}: ${entry.message}\n`);
    }
    if (testResult.failureMessage) process.stdout.write(`${testResult.failureMessage}\n`);
  }
}

module.exports = FailuresOnlyReporter;
