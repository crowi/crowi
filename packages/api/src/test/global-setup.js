const fs = require('node:fs');
const net = require('node:net');
const { getSentinelPath } = require('./test-mongo-sentinel');

// The dedicated, tmpfs-backed test mongod (`docker-compose.yml`'s
// `crowi-test-mongodb` service, feature-test-parallel-db-flake-hardening
// Phase 2 / A2). Probed FIRST — putting full-suite churn (~270 connects/run,
// create-db + autoIndex + dropDatabase per file) on its own disposable server
// keeps it off the same disk path as the always-on dev `mongodb` service
// (see the design doc's stall-window hypothesis).
//
// `maxPoolSize=10`: every test file opens its own mongoose connection, and
// the driver default pool is 100 sockets — under `--maxWorkers=N` that is a
// burst of N×100 simultaneous TCP connects to one shared mongod, which can
// overflow the listen backlog and surface as a transient `connect ETIMEDOUT`.
// Capping the pool keeps each file's footprint small (tests never need 100
// concurrent ops) without changing any production connection setting — it
// rides only on this test URI. `crowi-environment.js` splices the per-file db
// name onto the path and preserves this query string (and re-applies the
// same cap uniformly across every resolution path, so this inline value is
// belt-and-suspenders, not load-bearing).
const TEST_MONGODB_URI = 'mongodb://localhost:27018/?maxPoolSize=10';

// The always-on dev Mongo that `docker compose up -d` has started for years
// (`docker-compose.yml`'s `mongodb` service). Fallback when `crowi-test-mongodb`
// isn't reachable — e.g. a developer on an older compose checkout, or one who
// hasn't run `docker compose up -d` again since this service was added.
const DEV_MONGO_URI = 'mongodb://localhost:27017/?maxPoolSize=10';

/**
 * TCP liveness probe. A connect to a listening localhost port resolves in
 * ~1ms; a closed port rejects immediately with ECONNREFUSED — so this only
 * spends the timeout when the host is up but momentarily unresponsive.
 */
function probeTcp(uri, timeoutMs) {
  return new Promise((resolve) => {
    let host;
    let port;
    try {
      const url = new URL(uri);
      host = url.hostname;
      port = Number(url.port) || 27017;
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const PROBE_TIMEOUT_MS = 2000;

/**
 * Two attempts against the SAME candidate: the first runs at suite start
 * under no load, so a live server answers immediately; the retry only
 * guards a transient stall. Never advances to a different candidate — that
 * cascade lives in `resolveDockerCandidateUri` below.
 */
async function probeReachable(uri, probe) {
  return (await probe(uri, PROBE_TIMEOUT_MS)) || (await probe(uri, PROBE_TIMEOUT_MS));
}

// `x && x.trim()` (blank/whitespace-only counts as unset) recurs across the
// MONGO_URI / TEST_MONGO_URI checks below — named once so every call site
// reads the same way.
function isNonBlank(value) {
  return Boolean(value && value.trim());
}

/**
 * Pure resolution of which docker Mongo candidate (if any) `globalSetup`
 * should adopt, given the current `TEST_MONGO_URI` override (or lack of
 * one) and an injected TCP-probe function — extracted out of `globalSetup`
 * so a test can drive every branch deterministically without spinning up
 * real TCP listeners (see `global-setup.test.ts`).
 *
 * Priority (the bottom 4 rungs of the 5-step order documented on
 * `globalSetup` below; only `MONGO_URI` hard override sits ABOVE this
 * function and never calls it — the CI auto-detect guard sits INSIDE this
 * function's caller, gating only the case where `testMongoUriEnv` is unset,
 * so an explicit `TEST_MONGO_URI` still reaches this function and is probed
 * even when `CI === 'true'`):
 *
 *   `TEST_MONGO_URI` override (probed as the candidate itself; on failure
 *   returns `null` WITHOUT ever probing 27018/27017 — an isolated worktree
 *   pointing `TEST_MONGO_URI` at its own server must never be silently
 *   handed a reachable shared `crowi-test-mongodb` instead)
 *   > `crowi-test-mongodb` (27018) probe (skipped entirely when the caller
 *   determines CI should not auto-detect — see `globalSetup`)
 *   > dev `mongodb` (27017) probe
 *   > `null` (caller falls back to the per-file `mongodb-memory-server`).
 */
async function resolveDockerCandidateUri({ testMongoUriEnv, probe }) {
  if (isNonBlank(testMongoUriEnv)) {
    return (await probeReachable(testMongoUriEnv, probe)) ? testMongoUriEnv : null;
  }
  if (await probeReachable(TEST_MONGODB_URI, probe)) return TEST_MONGODB_URI;
  if (await probeReachable(DEV_MONGO_URI, probe)) return DEV_MONGO_URI;
  return null;
}

function writeSentinel(uri) {
  // Resolved at CALL time (not module-load time) via `getSentinelPath()` —
  // by the time this first runs, `globalSetup` below has already assigned
  // `CROWI_TEST_RUN_ID`, so the path is run-scoped from the very first
  // write.
  const sentinelPath = getSentinelPath();
  // Atomic write so a worker can never read a half-written file.
  const tmp = `${sentinelPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, uri);
  fs.renameSync(tmp, sentinelPath);
}

/**
 * jest `globalSetup`: runs ONCE in the jest main process, before any worker
 * forks. We decide the test-Mongo strategy here — exactly once, under no
 * parallel load — and hand the result to the per-worker test environments via
 * a sentinel file (see `test-mongo-sentinel.js` for why a file, not env).
 *
 * Deciding here, rather than in each worker, removes a race: a per-worker
 * probe contends with the boot thundering-herd, and a single load-spiked
 * false negative misroutes that worker to a mongodb-memory-server —
 * reintroducing the per-file native-mongod spawn that SIGSEGVs (and the
 * slow-mongod ETIMEDOUT) on full parallel runs.
 *
 * Resolution order (do not reorder — see the design doc's A2 "Mongo URI 解決
 * の優先順位". The historical `CI` fast-fail branch sits BELOW the
 * `TEST_MONGO_URI` override, not above it — an explicit override always
 * outranks the CI auto-detect guard, it only ever gates the un-overridden
 * 27018/27017 auto-detect cascade):
 *
 *   1. `MONGO_URI` already set (CI `services.mongo`, or an explicit local
 *      override) → leave detection alone entirely; `crowi-environment.js`
 *      reads `MONGO_URI` directly. No probe of any kind.
 *   2. `TEST_MONGO_URI` set → probed as the sole candidate, regardless of
 *      `CI`. Reachable: use it. Unreachable: fall straight to the
 *      memory-server (step 5) WITHOUT trying 27018/27017 — see
 *      `resolveDockerCandidateUri`'s doc comment.
 *   3. Neither set AND `process.env.CI === 'true'` → CI must supply
 *      `MONGO_URI` (or an explicit `TEST_MONGO_URI`); the 27018/27017
 *      auto-detect cascade never runs there (a CI runner could otherwise
 *      coincidentally have something answering on one of those ports and
 *      get silently adopted instead of the URI CI actually configured).
 *   4. No override, not CI → probe `crowi-test-mongodb` (27018), then dev
 *      `mongodb` (27017), in that order.
 *   5. Nothing reachable → empty sentinel; `crowi-environment.js` falls back
 *      to a per-file in-process memory-server (no-infrastructure machines
 *      still work).
 *
 * `deps.probeTcp` is a test-only injection point (defaults to the real
 * `probeTcp` above) — jest itself only ever calls this with the standard
 * `(globalConfig, projectConfig)` arguments, so production behaviour is
 * unchanged; `global-setup.test.ts` calls this function directly with a 3rd
 * argument to drive every resolution path deterministically.
 */
async function globalSetup(_globalConfig, _projectConfig, deps = {}) {
  const probe = deps.probeTcp ?? probeTcp;

  // Run-scope the sentinel BEFORE the first `writeSentinel()` call below —
  // this is what fixes the cross-run race described in the design doc
  // ("未報告バグ: sentinel の cross-run race"): two concurrent full-suite
  // runs (e.g. main worktree + a feature worktree, this repo's standard
  // workflow) now each generate their own id and therefore write to two
  // different sentinel paths, so neither run's teardown or startup can ever
  // clobber the other's in-flight strategy.
  //
  // `??=` (not a plain assignment): a run id set by an external caller
  // BEFORE spawning this jest process — the Phase 4 flake reporter spawns
  // `@crowi/api`'s jest directly (not through turbo) and sets this itself
  // so it can correlate the JSON Lines retry side-channel with the run it
  // orchestrated — must win over self-generation here.
  //
  // Every forked worker inherits this via `child_process.fork`'s env copy
  // at fork time, which happens strictly AFTER this function returns (see
  // `test-mongo-sentinel.js`'s doc comment for the full jest-internals
  // citation) — so every worker sees the same id without this value ever
  // needing to travel through the sentinel file itself.
  process.env.CROWI_TEST_RUN_ID ??= `${process.pid}-${Date.now().toString(36)}`;

  if (isNonBlank(process.env.MONGO_URI)) {
    writeSentinel(''); // env wins; don't also auto-detect.
    return;
  }

  const testMongoUriEnv = process.env.TEST_MONGO_URI;
  const hasTestMongoUriOverride = isNonBlank(testMongoUriEnv);

  // CI gates ONLY the un-overridden 27018/27017 auto-detect cascade below —
  // an explicit `TEST_MONGO_URI` still reaches `resolveDockerCandidateUri`
  // and gets probed even when `CI === 'true'`. Checking `testMongoUriEnv`
  // here (rather than folding this into `resolveDockerCandidateUri`) is what
  // keeps the priority order `MONGO_URI > TEST_MONGO_URI > CI-gated
  // auto-detect` instead of accidentally letting CI short-circuit ahead of
  // an explicit override.
  if (!hasTestMongoUriOverride && process.env.CI === 'true') {
    // CI must supply MONGO_URI via services.mongo; never auto-detect there.
    writeSentinel('');
    return;
  }

  const candidateUri = await resolveDockerCandidateUri({ testMongoUriEnv, probe });

  if (!candidateUri) {
    writeSentinel('');
    if (hasTestMongoUriOverride) {
      // Don't blame 27018/27017 here — they were never probed (see
      // `resolveDockerCandidateUri`'s doc comment), so naming them as
      // "unreachable" alongside the real culprit would mislead debugging.
      // eslint-disable-next-line no-console
      console.log(
        `[test] TEST_MONGO_URI override (${testMongoUriEnv}) is unreachable — falling back to mongodb-memory-server ` +
          '(slower; can SIGSEGV on large parallel runs). The 27018/27017 auto-detect cascade was NOT tried, ' +
          'since an explicit override always wins or falls back on its own, never silently to a different server.',
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        '[test] no docker Mongo reachable (neither crowi-test-mongodb:27018 nor the dev mongo:27017) — ' +
          'falling back to mongodb-memory-server (slower; can SIGSEGV on large parallel runs). ' +
          'Run `docker compose up -d` for the fast path.',
      );
    }
    return;
  }

  writeSentinel(candidateUri);
  if (hasTestMongoUriOverride) {
    // eslint-disable-next-line no-console
    console.log(`[test] using TEST_MONGO_URI override at ${candidateUri} (per-file dbs).`);
  } else if (candidateUri === TEST_MONGODB_URI) {
    // eslint-disable-next-line no-console
    console.log(`[test] using crowi-test-mongodb at ${candidateUri} (per-file dbs, tmpfs — dev data untouched).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[test] crowi-test-mongodb (port 27018) unreachable — using dev Mongo at ${candidateUri} (per-file dbs). ` +
        'Run `docker compose up -d` to also start crowi-test-mongodb and keep full-suite churn off the dev data disk path.',
    );
  }
}

module.exports = globalSetup;

// Test-only hooks (see `global-setup.test.ts`): attached as a static
// property on the exported function rather than a separate named export —
// jest's `globalSetup` config option requires the module to export a
// callable function directly, and a function is a perfectly normal place to
// hang extra static properties in JS (same pattern as `crowi-environment.js`'s
// `CrowiEnvironment.__test__`).
globalSetup.__test__ = { resolveDockerCandidateUri, probeTcp, TEST_MONGODB_URI, DEV_MONGO_URI };
