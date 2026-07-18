const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { getSentinelPath } = require('./test-mongo-sentinel');
const { REDIS_SMOKE_TARGETS, writeConnectivitySentinel } = require('./redis-smoke-sentinel');

// `@crowi/api`'s jest `globalSetup` — the ORIGINAL of this probe cascade
// (feature-test-parallel-db-flake-hardening, Phase 2 / A2 for the
// 27018→27017→memory-server cascade itself; Phase 3 / B1 for the
// protocol-identical duplication below). `packages/collab/src/__tests__/global-setup.js`
// and `packages/plugin-search-mongo/src/__tests__/global-setup.js` are
// DELIBERATE DUPLICATES of this file (each package probes independently —
// no shared npm package; see the design doc's B1 section for why).
//
// THIS FILE MUST STAY IN SYNC WITH:
//   - packages/collab/src/__tests__/global-setup.js
//   - packages/plugin-search-mongo/src/__tests__/global-setup.js
// If you change the protocol here (probe order, run-id generation, sentinel
// naming/format, maxPoolSize splice), check the other two.
//
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
 * feature-redis-8-upgrade Phase 2 — probe the 3 Redis targets Phase 1
 * landed (`docker-compose.yml` / `ci.yml`: shared `redis`, Config-smoke-only
 * `crowi-test-redis`, TLS fixture `crowi-test-redis-tls`) exactly once, here
 * in the main process before any worker forks — same reasoning as the Mongo
 * cascade above (a single load-spiked false negative under the boot
 * thundering-herd must not misroute a worker). Reuses the SAME `probeTcp` /
 * `probeReachable` this file already defines for Mongo — a bare TCP connect
 * is sufficient for a routing decision (the boot/TLS smoke test itself is
 * what verifies the TLS handshake actually completes).
 *
 * Unlike Mongo, there is no `crowi-environment.js` per-worker consumer for
 * these results — `src/test/redis-smoke.ts` reads the connectivity sentinel
 * SYNCHRONOUSLY at each `*.smoke.test.ts` file's collection time (so
 * `describe.skip` can be a normal declarative call; async reachability
 * can't gate `describe` registration otherwise) — see
 * `redis-smoke-sentinel.js`'s doc comment for the full protocol.
 */
async function probeRedisSmokeTargets(probe) {
  const result = {};
  for (const [key, url] of Object.entries(REDIS_SMOKE_TARGETS)) {
    result[key] = { url, reachable: await probeReachable(url, probe) };
  }
  return result;
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

/**
 * Write the run-scoped sentinel as a JSON `{ strategy, uri }` record (Phase
 * 3 / B3-2), used by EVERY branch below WITHOUT EXCEPTION — including the
 * `MONGO_URI` hard-override branch, which records `{ strategy:
 * 'env-override', uri: process.env.MONGO_URI }` (an earlier revision wrote
 * literal `''` there instead, on the theory that `crowi-environment.js`
 * never needs to read it since it returns straight from `process.env`; that
 * turned out to be the wrong call — a run-scoped record with NOTHING to
 * validate on the single MOST common branch in practice, CI's `MONGO_URI`
 * via `services.mongo`, defeats the entire "a full green run proves every
 * worker inherited the sentinel" property this file exists to provide, so
 * every branch now records a real, parseable strategy unconditionally).
 * `crowi-environment.js` can tell "docker-test (27018) chosen" apart from
 * "env-override chosen" apart from "nothing reachable, memory-server
 * fallback" apart from "sentinel unreadable / corrupt" (the last of which it
 * now warns loudly about instead of silently falling back, on EVERY branch
 * including its own `MONGO_URI` read — see that module's
 * `resolvedExternalMongoUri()`). `strategy` is one of `docker-test` /
 * `docker-dev` / `env-override` / `memory-server`; `uri` is `null` for
 * `memory-server`.
 *
 * (Re-raised in adversarial review as "shouldn't `MONGO_URI` just write `''`
 * per the design doc's B3-2 list of 4 resolved strategies?" — that list
 * enumerates the outcomes of the PROBE/resolution logic below (`docker-test`
 * / `docker-dev` / `env-override` for `TEST_MONGO_URI` / `memory-server`),
 * which `MONGO_URI` deliberately bypasses entirely; it does not say the
 * `MONGO_URI` branch must record nothing. Re-confirmed: writing `''` here
 * reopens exactly the gap `crowi-environment.test.ts`'s
 * "still returns process.env.MONGO_URI when set even if this run's OWN
 * sentinel is broken/missing" test now guards against — CI always sets
 * `MONGO_URI`, so a blank/absent sentinel on this branch alone would make
 * `resolvedExternalMongoUri()`'s B3-4 warn fire on literally every CI run.)
 *
 * Resolved at CALL time (not module-load time) via `getSentinelPath()` — by
 * the time this first runs, `globalSetup` below has already assigned
 * `CROWI_TEST_RUN_ID`, so the path is run-scoped from the very first write.
 */
function writeSentinel(payload) {
  const sentinelPath = getSentinelPath();
  const content = JSON.stringify(payload);
  // Atomic write so a worker can never read a half-written file.
  const tmp = `${sentinelPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, sentinelPath);
}

/**
 * `maxPoolSize` this module bakes into the URIs it resolves (`TEST_MONGODB_URI`
 * / `DEV_MONGO_URI` above) — the SAME value `crowi-environment.js` splices
 * uniformly onto every resolution path (`MONGO_URI` / `TEST_MONGO_URI`
 * override / memory-server; see that module's `buildPerFileUri()` and its
 * post-splice self-assert, Phase 3 / B3-1). Kept as its own constant here
 * (rather than parsed back out of the URI strings) so the drift-warn math
 * below (`warnOnWorkerPoolDrift`) stays correct even if a future edit
 * changes those URI literals.
 */
const ASSUMED_MAX_POOL_SIZE = 10;

/**
 * How many of those pooled connections a single test file's own
 * steady-state footprint holds open at once: 1 — the `beforeAll` boot
 * connection each file's tests reuse for its own lifetime (`setup.ts`). The
 * brief per-file `teardown()` connection (`maxPoolSize=1`, A1-2) overlaps it
 * only for the instant of the drop, not for the file's steady state, so it
 * is not counted here.
 */
const ASSUMED_POOLS_PER_WORKER = 1;

/**
 * `estimatedSockets > cpuCount * this` is treated as "far enough beyond this
 * machine's size to warrant a warning" — NOT "any amount over cpuCount",
 * which would fire on literally every normal run: today's default
 * (`--maxWorkers=5`, `packages/api/package.json:42`) times `maxPoolSize=10`
 * already estimates 50 simultaneous sockets, which already exceeds the CPU
 * count of most laptops — and that configuration is the intentionally
 * analyzed, ACCEPTED one (see A1-3 in the design doc), not drift. Flagging
 * it on every single run would just train developers to ignore the
 * warning. This multiplier is a heuristic, not a hard limit (this check is
 * a warn, never a fail — machine sizes vary too much for a universal
 * threshold, Phase 3 / B3-3); it only fires once a change (`--maxWorkers`
 * raised, or the `maxPoolSize=10` cap accidentally reverted toward the
 * driver's default of 100) pushes the estimate well past what today's
 * default already spends.
 */
const SOCKET_BUDGET_PER_CPU = 10;

/**
 * `global-setup.js` never has the resolved test Mongo URI in hand on the
 * `MONGO_URI` / CI-guard branches (see `writeSentinel()`'s doc comment
 * above), so it cannot assert `maxPoolSize=10` the way `crowi-environment.js`
 * does post-splice (Phase 3 / B3-1) — there is nothing to assert against on
 * those paths. What it CAN check, independent of which URI ends up
 * resolved, is whether `--maxWorkers` and the assumed pool size together add
 * up to a socket count wildly disproportionate to this machine — e.g.
 * someone raised `--maxWorkers` without reconsidering the shared mongod's
 * listen backlog, or a future edit accidentally reverted the uniform
 * `maxPoolSize=10` splice (A1-3) back toward the driver's default of 100.
 * WARN only, never fail (Phase 3 / B3-3).
 *
 * `deps.cpuCount` is a test-only injection point (defaults to
 * `os.cpus().length`) so `global-setup.test.ts` can drive both branches
 * deterministically without depending on the actual host's core count.
 */
function warnOnWorkerPoolDrift(globalConfig, deps) {
  const cpuCount = deps.cpuCount ?? os.cpus().length;
  const maxWorkers = typeof globalConfig?.maxWorkers === 'number' && globalConfig.maxWorkers > 0 ? globalConfig.maxWorkers : 1;
  const estimatedSockets = maxWorkers * ASSUMED_POOLS_PER_WORKER * ASSUMED_MAX_POOL_SIZE;

  if (maxWorkers > cpuCount) {
    // eslint-disable-next-line no-console
    console.warn(
      `[test-harness] jest --maxWorkers=${maxWorkers} exceeds this machine's CPU count (${cpuCount}) — each worker ` +
        'boots its own Crowi + Mongo connection, so oversubscribing workers past core count adds contention without ' +
        'adding throughput (feature-test-parallel-db-flake-hardening Phase 3 / B3-3).',
    );
  }
  if (estimatedSockets > cpuCount * SOCKET_BUDGET_PER_CPU) {
    // eslint-disable-next-line no-console
    console.warn(
      `[test-harness] estimated simultaneous DB sockets against the shared test mongod (~${estimatedSockets} = ` +
        `maxWorkers(${maxWorkers}) × maxPoolSize(${ASSUMED_MAX_POOL_SIZE})) is far beyond this machine's CPU count ` +
        `(${cpuCount}) — check whether --maxWorkers was raised or the maxPoolSize=10 cap (A1-3) was reverted, either ` +
        'of which risks the listen-backlog-overflow ETIMEDOUT class this pool cap exists to prevent.',
    );
  }
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
 *      reads `MONGO_URI` directly, NOT this sentinel's `uri` field. No probe
 *      of any kind. Sentinel strategy: `env-override`, `uri:
 *      process.env.MONGO_URI` (recorded, not merely probed-and-echoed, so
 *      `crowi-environment.js` still has a real record to validate against a
 *      broken/missing sentinel on this branch too — see `writeSentinel()`'s
 *      doc comment).
 *   2. `TEST_MONGO_URI` set → probed as the sole candidate, regardless of
 *      `CI`. Reachable: use it (sentinel strategy `env-override`).
 *      Unreachable: fall straight to the memory-server (step 5) WITHOUT
 *      trying 27018/27017 — see `resolveDockerCandidateUri`'s doc comment.
 *   3. Neither set AND `process.env.CI === 'true'` → CI must supply
 *      `MONGO_URI` (or an explicit `TEST_MONGO_URI`); the 27018/27017
 *      auto-detect cascade never runs there (a CI runner could otherwise
 *      coincidentally have something answering on one of those ports and
 *      get silently adopted instead of the URI CI actually configured).
 *      Sentinel strategy: `memory-server` (matches step 5's recorded
 *      strategy — `crowi-environment.js`'s OWN `process.env.CI === 'true'`
 *      check, not this sentinel value, is what actually fail-fasts that
 *      branch; see that module's `setup()`).
 *   4. No override, not CI → probe `crowi-test-mongodb` (27018), then dev
 *      `mongodb` (27017), in that order. Sentinel strategy: `docker-test` or
 *      `docker-dev` respectively (Phase 3 / B3-2).
 *   5. Nothing reachable → sentinel strategy `memory-server`, `uri: null`;
 *      `crowi-environment.js` falls back to a per-file in-process
 *      memory-server (no-infrastructure machines still work).
 *
 * `deps.probeTcp` / `deps.cpuCount` are test-only injection points (default
 * to the real `probeTcp` above / `os.cpus().length`) — jest itself only ever
 * calls this with the standard `(globalConfig, projectConfig)` arguments, so
 * production behaviour is unchanged; `global-setup.test.ts` calls this
 * function directly with a 3rd argument to drive every resolution path (and
 * the `warnOnWorkerPoolDrift` branches) deterministically.
 */
async function globalSetup(globalConfig, _projectConfig, deps = {}) {
  const probe = deps.probeTcp ?? probeTcp;
  // Independent of which Mongo strategy ends up resolved below — see
  // `warnOnWorkerPoolDrift`'s doc comment.
  warnOnWorkerPoolDrift(globalConfig, deps);

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

  // feature-redis-8-upgrade Phase 2 — probe the 3 Redis targets ONCE, here,
  // independent of the Mongo branching below (every early `return` past
  // this point must still have run this). CI (`process.env.CI === 'true'`)
  // fails the WHOLE run immediately when any target is unreachable — Phase 1
  // guarantees all 3 exist in CI, so an unreachable one is an infra
  // regression, never a "skip and stay green" situation (mirrors this same
  // function's Mongo CI-guard philosophy, but the opposite polarity: Mongo
  // auto-detects locally and requires an explicit URI in CI; Redis probes
  // the SAME 3 fixed targets in both environments and only diverges on what
  // an unreachable result means). Local (non-CI): record reachability and
  // let each `*.smoke.test.ts` file's `describe.skip` react to it — no
  // fast-fail.
  const redisSmokeResult = await probeRedisSmokeTargets(probe);
  writeConnectivitySentinel(redisSmokeResult);
  if (process.env.CI === 'true') {
    const unreachable = Object.entries(redisSmokeResult)
      .filter(([, v]) => !v.reachable)
      .map(([key, v]) => `${key} (${v.url})`);
    if (unreachable.length > 0) {
      throw new Error(
        `[test] CI Redis smoke target(s) unreachable, failing fast (feature-redis-8-upgrade Phase 1 provisions all 3 ` +
          `unconditionally in CI, so this is an infra regression, not an expected gap): ${unreachable.join(', ')}`,
      );
    }
  }

  if (isNonBlank(process.env.MONGO_URI)) {
    // env wins; don't also auto-detect. Recorded (not merely `''`, see
    // `writeSentinel()`'s doc comment) so `crowi-environment.js` still has a
    // real strategy to validate on this branch — CI's MOST common shape.
    writeSentinel({ strategy: 'env-override', uri: process.env.MONGO_URI });
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
    // Recorded strategy is `memory-server` — see this function's doc
    // comment, step 3: it's `crowi-environment.js`'s OWN `CI === 'true'`
    // check that actually fail-fasts this branch, not this sentinel value.
    writeSentinel({ strategy: 'memory-server', uri: null });
    return;
  }

  const candidateUri = await resolveDockerCandidateUri({ testMongoUriEnv, probe });

  if (!candidateUri) {
    writeSentinel({ strategy: 'memory-server', uri: null });
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

  // Strategy naming for the sentinel record (Phase 3 / B3-2): `env-override`
  // when `TEST_MONGO_URI` itself was the reachable candidate, else
  // `docker-test` (27018) / `docker-dev` (27017) depending on which rung of
  // the auto-detect cascade answered.
  const strategy = hasTestMongoUriOverride ? 'env-override' : candidateUri === TEST_MONGODB_URI ? 'docker-test' : 'docker-dev';
  writeSentinel({ strategy, uri: candidateUri });
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
globalSetup.__test__ = {
  resolveDockerCandidateUri,
  probeTcp,
  TEST_MONGODB_URI,
  DEV_MONGO_URI,
  warnOnWorkerPoolDrift,
  ASSUMED_MAX_POOL_SIZE,
  SOCKET_BUDGET_PER_CPU,
  probeRedisSmokeTargets,
};
