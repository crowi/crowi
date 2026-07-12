const fs = require('node:fs');
const net = require('node:net');
const { getSentinelPath } = require('./test-mongo-sentinel');

// Local Mongo that `docker compose up -d` exposes. Overridable so a dev can
// point the suite at a different test server without editing config.
//
// `maxPoolSize=10`: every test file opens its own mongoose connection, and the
// driver default pool is 100 sockets — under `--maxWorkers=N` that is a burst
// of N×100 simultaneous TCP connects to the one shared mongod, which can
// overflow the listen backlog and surface as a transient `connect ETIMEDOUT`.
// Capping the pool keeps each file's footprint small (tests never need 100
// concurrent ops) without changing any production connection setting — it
// rides only on this test URI. `crowi-environment.js` splices the per-file db
// name onto the path and preserves this query string.
const DOCKER_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/?maxPoolSize=10';

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
 *   - MONGO_URI already set (CI services.mongo, or an explicit override) →
 *     leave detection alone; crowi-environment.js reads MONGO_URI directly.
 *   - else a local docker Mongo is reachable → record it in the sentinel.
 *   - else → empty sentinel; crowi-environment.js falls back to an in-process
 *     memory-server (no-infrastructure machines still work).
 */
module.exports = async function globalSetup() {
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

  if (process.env.MONGO_URI && process.env.MONGO_URI.trim()) {
    writeSentinel(''); // env wins; don't also auto-detect.
    return;
  }
  if (process.env.CI === 'true') {
    // CI must supply MONGO_URI via services.mongo; never auto-detect there.
    writeSentinel('');
    return;
  }
  // Two attempts: the first runs at suite start under no load, so a live
  // server answers immediately; the retry only guards a transient stall.
  const reachable = (await probeTcp(DOCKER_MONGO_URI, 2000)) || (await probeTcp(DOCKER_MONGO_URI, 2000));
  if (reachable) {
    writeSentinel(DOCKER_MONGO_URI);
    // eslint-disable-next-line no-console
    console.log(`[test] using docker Mongo at ${DOCKER_MONGO_URI} (per-file dbs); set TEST_MONGO_URI to override.`);
  } else {
    writeSentinel('');
    // eslint-disable-next-line no-console
    console.log(
      '[test] no docker Mongo reachable — falling back to mongodb-memory-server (slower; can SIGSEGV on large parallel runs). Run `docker compose up -d` for the fast path.',
    );
  }
};
