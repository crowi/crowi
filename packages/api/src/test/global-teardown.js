const fs = require('node:fs');
const { getSentinelPath } = require('./test-mongo-sentinel');

// Best-effort: remove the Mongo-strategy sentinel written by global-setup.js
// for THIS run only. Safe now that the sentinel path is run-scoped
// (`CROWI_TEST_RUN_ID`, set in global-setup.js before any worker forks) — a
// concurrent full-suite run on the same machine (e.g. main worktree + a
// feature worktree) generated its own id and therefore owns a different
// sentinel path, so this can never delete another run's in-flight file (the
// bug this scoping fixes — see the design doc's "未報告バグ: sentinel の
// cross-run race"). Non-fatal if it's already gone.
module.exports = async function globalTeardown() {
  try {
    fs.rmSync(getSentinelPath(), { force: true });
  } catch {
    // ignore — including a possibly-unset CROWI_TEST_RUN_ID; teardown must
    // never throw and block the run from reporting its result.
  }
};
