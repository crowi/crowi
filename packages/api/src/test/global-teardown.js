const fs = require('node:fs');
const { getSentinelPath } = require('./test-mongo-sentinel');
const { REDIS_SMOKE_CATEGORIES, listMarkedCategories, removeAllMarkersAndSentinel } = require('./redis-smoke-sentinel');

/**
 * feature-redis-8-upgrade Phase 2 — CI-gate the 8 Redis smoke categories.
 * jest `globalTeardown` runs ONCE, in the main process, strictly AFTER every
 * worker's every test file has finished (same jest-internals guarantee
 * `test-mongo-sentinel.js` documents for `globalSetup`, mirrored here for
 * the tail end of the run) — so this is race-free by construction: no
 * category marker can still be "in flight" from a worker by the time this
 * runs, unlike a dedicated counter-assertion test file racing the smoke
 * files under `--maxWorkers=5` would be (see the spec's "CI sentinel の非
 * レース化" for why that design was rejected).
 *
 * Local (non-CI): never throws — a developer without `docker compose up -d`
 * running sees 0 (or a partial set of) markers and that's expected; only CI
 * (where Phase 1 guarantees all 3 Redis instances exist) treats a shortfall
 * as an infra regression.
 */
function checkRedisSmokeCategoryCoverage() {
  if (process.env.CI !== 'true') return;
  const ran = listMarkedCategories();
  if (ran.length >= REDIS_SMOKE_CATEGORIES.length) return;
  const missing = REDIS_SMOKE_CATEGORIES.filter((category) => !ran.includes(category));
  throw new Error(
    `[test] Redis smoke categories missing in CI (ran ${ran.length}/${REDIS_SMOKE_CATEGORIES.length}): ${missing.join(', ')} — ` +
      'each category records a marker in its own `beforeAll` (proof the describe block was not skipped); a missing ' +
      'marker means that smoke suite never ran even though CI (per feature-redis-8-upgrade Phase 1) guarantees the ' +
      'underlying Redis instances are reachable.',
  );
}

module.exports = async function globalTeardown() {
  // Best-effort: remove the Mongo-strategy sentinel written by
  // global-setup.js for THIS run only. Safe now that the sentinel path is
  // run-scoped (`CROWI_TEST_RUN_ID`, set in global-setup.js before any
  // worker forks) — a concurrent full-suite run on the same machine (e.g.
  // main worktree + a feature worktree) generated its own id and therefore
  // owns a different sentinel path, so this can never delete another run's
  // in-flight file (the bug this scoping fixes — see the design doc's "未報
  // 告バグ: sentinel の cross-run race"). Non-fatal if it's already gone.
  try {
    fs.rmSync(getSentinelPath(), { force: true });
  } catch {
    // ignore — including a possibly-unset CROWI_TEST_RUN_ID; this cleanup
    // must never throw and mask the real result.
  }

  // The CI category-count check below is allowed to throw (that's the
  // whole point — it's what fails the run on a coverage regression), but
  // this run's own marker files + connectivity sentinel must be cleaned up
  // regardless of whether it does.
  try {
    checkRedisSmokeCategoryCoverage();
  } finally {
    try {
      removeAllMarkersAndSentinel();
    } catch {
      // best-effort — including a possibly-unset CROWI_TEST_RUN_ID.
    }
  }
};
