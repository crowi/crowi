const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// feature-redis-8-upgrade Phase 2 — the run-scoped sentinel/marker
// protocol backing `src/test/redis-smoke.ts` (connectivity decisions) and
// `global-teardown.js` (CI category-count gate). Deliberately a plain CJS
// module — like `test-mongo-sentinel.js` — so `global-setup.js` /
// `global-teardown.js` (loaded by jest as raw scripts, not part of the
// `server` ts-jest project) can `require()` it directly, while
// `redis-smoke.ts` reaches it through the SAME `require()` (allowJs, no
// type-check needed on this file).
//
// Two independent artifacts, both run-scoped by `CROWI_TEST_RUN_ID`
// (guaranteed set by `global-setup.js` before any worker forks — see
// `test-mongo-sentinel.js`'s doc comment for the jest-internals citation
// this relies on):
//
//   1. Connectivity sentinel — ONE JSON file, written ONCE by
//      `global-setup.js` (main process, pre-fork) recording whether each
//      of the 3 Redis targets (`shared` / `config` / `tls`) was reachable.
//      Read synchronously by `redis-smoke.ts` at test-file COLLECTION
//      time (each worker `require()`-ing a `*.smoke.test.ts` file) so
//      `describe.skip` can be a normal declarative call — async
//      reachability can't gate `describe`/`it` registration otherwise.
//   2. Category markers — one file PER smoke category, written by the
//      category's own `beforeAll` (proof the describe block actually ran,
//      not skipped) via the same atomic tmp+rename pattern as
//      `test-mongo-sentinel.js`'s `writeSentinel()`. `global-teardown.js`
//      enumerates them after every worker's tests finished (jest
//      `globalTeardown` — the SAME race-free timing property
//      `test-mongo-sentinel.js` documents) and, in CI, fails the whole
//      run if fewer than 8 distinct categories are present.

/** The 3 Redis instances Phase 1 landed (docker-compose.yml / ci.yml). */
const REDIS_SMOKE_TARGETS = {
  shared: 'redis://127.0.0.1:6379',
  config: 'redis://127.0.0.1:6380',
  tls: 'rediss://127.0.0.1:6381',
};

/** The 9 real-Redis consumer categories (8 features + `boot`) Phase 2 must exercise. */
const REDIS_SMOKE_CATEGORIES = ['collab', 'editor-cap', 'presence', 'notifications', 'config', 'rate-limit', 'lru', 'link-completion', 'boot'];

function requireRunId() {
  const runId = process.env.CROWI_TEST_RUN_ID;
  if (!runId) {
    // Same fail-loud posture as `test-mongo-sentinel.js`'s `getSentinelPath()`
    // — an unset run id here means env propagation to this process is
    // broken; falling back to a machine-shared path would reintroduce the
    // exact cross-run race the scoping exists to prevent.
    throw new Error(
      'redis-smoke-sentinel: CROWI_TEST_RUN_ID is unset. This should always be inherited from global-setup.js ' +
        '(set before any jest worker forks, or before global-setup.js itself runs in the main process).',
    );
  }
  return runId;
}

function getConnectivitySentinelPath() {
  return path.join(os.tmpdir(), `crowi-redis-smoke-connectivity.${requireRunId()}.json`);
}

function getMarkerPath(category) {
  if (!REDIS_SMOKE_CATEGORIES.includes(category)) {
    throw new Error(`redis-smoke-sentinel: unknown category "${category}" (expected one of ${REDIS_SMOKE_CATEGORIES.join(', ')})`);
  }
  return path.join(os.tmpdir(), `crowi-redis-smoke.${requireRunId()}.${category}.marker`);
}

/** Atomic tmp+rename write — mirrors `global-setup.js`'s `writeSentinel()`. */
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** Written ONCE by `global-setup.js`, before any worker forks. */
function writeConnectivitySentinel(result) {
  atomicWrite(getConnectivitySentinelPath(), JSON.stringify(result));
}

/**
 * Read the connectivity sentinel synchronously. Returns `null` when
 * missing/corrupt (unreadable) — callers decide their own fallback
 * (`redis-smoke.ts` treats this as "nothing reachable" and warns loudly
 * in CI, since `global-setup.js` always writes this file before any
 * worker starts).
 */
function readConnectivitySentinel() {
  try {
    return JSON.parse(fs.readFileSync(getConnectivitySentinelPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** Written by a smoke category's `beforeAll` — proof the describe block ran (not `.skip`-ped). */
function writeMarker(category) {
  atomicWrite(getMarkerPath(category), String(Date.now()));
}

/** Enumerate which categories recorded a marker for the current run. */
function listMarkedCategories() {
  const runId = requireRunId();
  const prefix = `crowi-redis-smoke.${runId}.`;
  const suffix = '.marker';
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return [];
  }
  const found = new Set();
  for (const name of entries) {
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
      const category = name.slice(prefix.length, name.length - suffix.length);
      // Only count known categories — an unrecognized marker name under the
      // same run id (stray file, future rename mismatch) must not inflate
      // the distinct count toward a false CI pass.
      if (REDIS_SMOKE_CATEGORIES.includes(category)) {
        found.add(category);
      }
    }
  }
  return [...found];
}

/** Best-effort cleanup of every marker + the connectivity sentinel for this run. */
function removeAllMarkersAndSentinel() {
  try {
    fs.rmSync(getConnectivitySentinelPath(), { force: true });
  } catch {
    // ignore — including a possibly-unset CROWI_TEST_RUN_ID.
  }
  for (const category of REDIS_SMOKE_CATEGORIES) {
    try {
      fs.rmSync(getMarkerPath(category), { force: true });
    } catch {
      // ignore
    }
  }
}

module.exports = {
  REDIS_SMOKE_TARGETS,
  REDIS_SMOKE_CATEGORIES,
  requireRunId,
  getConnectivitySentinelPath,
  getMarkerPath,
  writeConnectivitySentinel,
  readConnectivitySentinel,
  writeMarker,
  listMarkedCategories,
  removeAllMarkersAndSentinel,
};
