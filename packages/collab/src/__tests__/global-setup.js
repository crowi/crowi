const fs = require('node:fs');
const net = require('node:net');
const { getSentinelPath } = require('./mongo-sentinel');

// `@crowi/collab`'s OWN jest `globalSetup` — a deliberate, protocol-identical
// DUPLICATE of `packages/api/src/test/global-setup.js` and
// `packages/plugin-search-mongo/src/__tests__/global-setup.js`
// (feature-test-parallel-db-flake-hardening, Phase 3 / B1). Before this,
// every collab test file spun up its own `MongoMemoryServer` independently
// (`setup.ts`'s `startInMemoryMongo()`), which meant `root pnpm test`'s
// `@crowi/collab` suite (10 files) spawned 10 native mongod processes on top
// of whatever `@crowi/api`'s suite was already doing. Probing here — once,
// centrally, before this package's own jest workers fork — and handing the
// result to every test file via a sentinel lets collab's tests share the
// SAME docker Mongo `@crowi/api` uses (or fall back to memory-server
// per-file exactly as before when no docker Mongo is reachable), without
// ever reading `@crowi/api`'s own sentinel (that package's jest process may
// not even be running — see the design doc's B1 section for why a
// read-only shared helper was rejected in favor of each package probing
// independently).
//
// THIS FILE MUST STAY IN SYNC WITH:
//   - packages/api/src/test/global-setup.js
//   - packages/plugin-search-mongo/src/__tests__/global-setup.js
// If you change the protocol here (probe order, run-id generation, sentinel
// naming, maxPoolSize splice), check the other two.
//
// Same ports as `@crowi/api` — both point at the SAME docker-compose
// services (`docker-compose.yml`'s `crowi-test-mongodb` on 27018 and
// `mongodb` on 27017), so no new infra is needed for collab specifically.
const TEST_MONGODB_URI = 'mongodb://localhost:27018/?maxPoolSize=10';
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

/** Two attempts against the SAME candidate — see `packages/api`'s equivalent for the full rationale. */
async function probeReachable(uri, probe) {
  return (await probe(uri, PROBE_TIMEOUT_MS)) || (await probe(uri, PROBE_TIMEOUT_MS));
}

function isNonBlank(value) {
  return Boolean(value && value.trim());
}

/** Pure resolution of the docker candidate — see `packages/api/src/test/global-setup.js`'s equivalent for the full doc comment. */
async function resolveDockerCandidateUri({ testMongoUriEnv, probe }) {
  if (isNonBlank(testMongoUriEnv)) {
    return (await probeReachable(testMongoUriEnv, probe)) ? testMongoUriEnv : null;
  }
  if (await probeReachable(TEST_MONGODB_URI, probe)) return TEST_MONGODB_URI;
  if (await probeReachable(DEV_MONGO_URI, probe)) return DEV_MONGO_URI;
  return null;
}

/**
 * Write the run-scoped sentinel as a JSON `{ strategy, uri }` record —
 * protocol-identical to `@crowi/api`'s `global-setup.js` `writeSentinel()`
 * (Phase 3 / B3-2, synchronized across all three packages per Phase 3
 * rework: an earlier revision of this file kept a simpler plain-URI-text
 * format on the theory that collab has no B3-4-equivalent loud-warn
 * requirement on the reader side — true, but irrelevant to the WRITE side,
 * and "protocol-identical" duplication across the three packages means the
 * wire format itself, not just probe order / run-id generation / sentinel
 * naming, must match). `strategy` is one of `docker-test` / `docker-dev` /
 * `env-override` / `memory-server`; `uri` is `null` for `memory-server`.
 * `setup.ts`'s `resolvedExternalMongoUri()` parses this record (without
 * adding a B3-4-style loud warn — see that file's doc comment for why that
 * part intentionally stays simpler than `@crowi/api`'s).
 */
function writeSentinel(payload) {
  const sentinelPath = getSentinelPath();
  const content = JSON.stringify(payload);
  const tmp = `${sentinelPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, sentinelPath);
}

/**
 * jest `globalSetup` for `@crowi/collab`. Runs ONCE in this package's own
 * jest main process, before any of ITS worker forks — entirely independent
 * of whether `@crowi/api`'s jest process is running at all.
 *
 * Resolution order (identical to `packages/api/src/test/global-setup.js` —
 * do not reorder without updating that file too):
 *
 *   1. `MONGO_URI` already set (CI `services.mongo` sets this at the JOB
 *      level, so every `pnpm test` step in that job — including this
 *      package's — inherits it; a local override works the same way) →
 *      leave detection alone entirely; `setup.ts` reads `MONGO_URI`
 *      directly, NOT this sentinel's `uri` field. No probe of any kind.
 *      Sentinel strategy: `env-override`, `uri: process.env.MONGO_URI`.
 *   2. `TEST_MONGO_URI` set → probed as the sole candidate, regardless of
 *      `CI`. Reachable: use it (sentinel strategy `env-override`).
 *      Unreachable: fall straight to the memory-server (step 5) WITHOUT
 *      trying 27018/27017.
 *   3. Neither set AND `process.env.CI === 'true'` → the 27018/27017
 *      auto-detect cascade never runs there (see `packages/api`'s
 *      equivalent doc comment for the full rationale). Sentinel strategy:
 *      `memory-server`.
 *   4. No override, not CI → probe `crowi-test-mongodb` (27018), then dev
 *      `mongodb` (27017), in that order. Sentinel strategy: `docker-test` or
 *      `docker-dev` respectively.
 *   5. Nothing reachable → sentinel strategy `memory-server`, `uri: null`;
 *      `setup.ts` falls back to a per-file in-process `mongodb-memory-server`
 *      (unchanged from this package's pre-Phase-3 behaviour).
 *
 * `deps.probeTcp` is a test-only injection point (defaults to the real
 * `probeTcp` above) — jest itself only ever calls this with the standard
 * `(globalConfig, projectConfig)` arguments, so production behaviour is
 * unchanged.
 */
async function globalSetup(_globalConfig, _projectConfig, deps = {}) {
  const probe = deps.probeTcp ?? probeTcp;

  // Run-scope the sentinel BEFORE the first `writeSentinel()` call — see
  // `packages/api/src/test/global-setup.js`'s equivalent for the full
  // jest-internals citation proving every forked worker inherits this.
  process.env.CROWI_TEST_RUN_ID ??= `${process.pid}-${Date.now().toString(36)}`;

  if (isNonBlank(process.env.MONGO_URI)) {
    // env wins; don't also auto-detect. Recorded (not `''`) so `setup.ts`'s
    // reader always has a real strategy to parse on this branch too.
    writeSentinel({ strategy: 'env-override', uri: process.env.MONGO_URI });
    return;
  }

  const testMongoUriEnv = process.env.TEST_MONGO_URI;
  const hasTestMongoUriOverride = isNonBlank(testMongoUriEnv);

  if (!hasTestMongoUriOverride && process.env.CI === 'true') {
    writeSentinel({ strategy: 'memory-server', uri: null });
    return;
  }

  const candidateUri = await resolveDockerCandidateUri({ testMongoUriEnv, probe });

  if (!candidateUri) {
    writeSentinel({ strategy: 'memory-server', uri: null });
    if (hasTestMongoUriOverride) {
      // eslint-disable-next-line no-console
      console.log(`[collab-test] TEST_MONGO_URI override (${testMongoUriEnv}) is unreachable — falling back to mongodb-memory-server per file.`);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        '[collab-test] no docker Mongo reachable (neither crowi-test-mongodb:27018 nor the dev mongo:27017) — ' +
          'falling back to mongodb-memory-server per file. Run `docker compose up -d` for the fast path.',
      );
    }
    return;
  }

  // Strategy naming (Phase 3 / B3-2, protocol-identical to `@crowi/api`'s
  // equivalent): `env-override` when `TEST_MONGO_URI` itself was the
  // reachable candidate, else `docker-test` (27018) / `docker-dev` (27017)
  // depending on which rung of the auto-detect cascade answered.
  const strategy = hasTestMongoUriOverride ? 'env-override' : candidateUri === TEST_MONGODB_URI ? 'docker-test' : 'docker-dev';
  writeSentinel({ strategy, uri: candidateUri });
  if (hasTestMongoUriOverride) {
    // eslint-disable-next-line no-console
    console.log(`[collab-test] using TEST_MONGO_URI override at ${candidateUri} (per-file dbs).`);
  } else if (candidateUri === TEST_MONGODB_URI) {
    // eslint-disable-next-line no-console
    console.log(`[collab-test] using crowi-test-mongodb at ${candidateUri} (per-file dbs).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[collab-test] crowi-test-mongodb (27018) unreachable — using dev Mongo at ${candidateUri} (per-file dbs).`);
  }
}

module.exports = globalSetup;

// Test-only hooks — see `packages/api/src/test/global-setup.js`'s equivalent for the pattern.
globalSetup.__test__ = { resolveDockerCandidateUri, probeTcp, TEST_MONGODB_URI, DEV_MONGO_URI };
