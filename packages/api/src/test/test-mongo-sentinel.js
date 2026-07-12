const os = require('node:os');
const path = require('node:path');

// File written ONCE by `global-setup.js` (jest main process, before any
// worker forks) and read by every worker's `crowi-environment.js`. It
// carries the resolved external Mongo URI (the docker server, if reachable)
// or is empty when none was reachable. A file — not a bare read of
// `process.env` from `global-setup.js` — because a worker needs to be able
// to tell "docker is unreachable" (empty sentinel) apart from "the
// globalSetup mutation never arrived" (see `getSentinelPath()` below) and a
// file written once, fully, before any worker starts (atomic tmp+rename in
// `global-setup.js`) is trivially visible to all of them either way.
//
// Path is scoped PER RUN, not machine-global: `getSentinelPath()` resolves
// `process.env.CROWI_TEST_RUN_ID` at CALL time (not at module-require time)
// so a single test-Mongo strategy never leaks across two concurrent full
// suite runs on the same machine (main worktree + a feature worktree
// running `pnpm --filter @crowi/api test` at the same time is the repo's
// standard workflow — see feature-test-parallel-db-flake-hardening's spec,
// "未報告バグ: sentinel の cross-run race"). `global-setup.js` generates
// `CROWI_TEST_RUN_ID` once, in its own function body, before writing the
// sentinel for the first time.
//
// Why resolving the path is safe to defer to call time, and why every
// worker sees the same `CROWI_TEST_RUN_ID` its main process generated:
// jest's `globalSetup` runs ONCE, in the jest MAIN process, and completes
// BEFORE any worker is forked (`@jest/core@29.7.0`'s `runJest.js` awaits
// `runGlobalHook({ moduleName: 'globalSetup' })` — a same-process
// require+call, no subprocess involved — strictly before
// `scheduler.scheduleTests(...)` forks any worker). Each worker is then
// spawned via `child_process.fork(childWorkerPath, [], { env: {
// ...process.env, ... } })` (`jest-worker@29.7.0`'s
// `ChildProcessWorker.initialize()`), which copies the CURRENT
// `process.env` of the main process wholesale at fork time — by
// definition strictly after `globalSetup` (and its `CROWI_TEST_RUN_ID`
// assignment) already ran. So every forked worker inherits the run id
// without needing a file (or anything else) to carry it across the
// fork boundary; `--runInBand` doesn't even fork a worker
// (`TestScheduler.js`'s `shouldRunInBand` runs tests serially in the main
// process), so it trivially shares the same `process.env` too.
//
// (An earlier version of this comment claimed the opposite — that "jest
// does not reliably propagate a globalSetup env mutation to every forked
// worker" — which is why the sentinel exists as a file at all. That
// specific claim was never actually true for a mutation made before any
// worker forks; the file remains useful for a different reason: it lets a
// worker distinguish "no docker Mongo reachable" from "my run id's
// sentinel was never written / got lost", per `getSentinelPath()` below.)
function getSentinelPath() {
  const runId = process.env.CROWI_TEST_RUN_ID;
  if (!runId) {
    // A worker inherits `CROWI_TEST_RUN_ID` via `child_process.fork`'s env
    // copy at fork time (see above) — it is ALWAYS set by the time any
    // worker-side code reaches here. Falling back to a machine-shared path
    // instead of throwing would silently reintroduce the exact cross-run
    // race this run-scoping fixes, just relocated from "teardown deletes a
    // shared file" to "two runs' workers read/write the same shared file
    // throughout". Fail loud instead: the failure itself is a load-bearing
    // signal that env propagation broke (see A1-4 in the design doc).
    throw new Error(
      'test-mongo-sentinel: CROWI_TEST_RUN_ID is unset. This should always be inherited from ' +
        'global-setup.js (set before any jest worker forks) — an unset value here means env ' +
        'propagation to this worker is broken. Refusing to fall back to a machine-shared ' +
        'sentinel path (that is the exact cross-run race this run-scoping exists to prevent).',
    );
  }
  return path.join(os.tmpdir(), `crowi-api-test-mongo-uri.${runId}`);
}

module.exports = { getSentinelPath };
