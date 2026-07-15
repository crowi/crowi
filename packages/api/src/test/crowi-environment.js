require('regenerator-runtime/runtime');
const NodeEnvironment = require('jest-environment-node').default || require('jest-environment-node');
const fs = require('node:fs');
const path = require('path');
const { randomBytes } = require('node:crypto');
const { getSentinelPath } = require('./test-mongo-sentinel');
const failureTaxonomyChannel = require('./failure-taxonomy-channel');

const ROOT_DIR = path.join(__dirname, '../..');
const MODEL_DIR = path.join(__dirname, '../models');

// `[test-harness] ` — NOT `[crowi] `. `setup.ts` silences every
// `[crowi] `-prefixed console.warn as boot-time noise (see that file's
// `QUIET_PREFIXES`); using that prefix here would make this warning
// invisible on screen even though "must be visible" is the entire point
// (Phase 3 / B3-4 — this replaces a silent fallback, so silently filtering
// the replacement warning would defeat the purpose just as badly).
function warnSentinelUnreadable(detail) {
  console.warn(
    `[test-harness] crowi-environment: could not determine this run's resolved Mongo strategy (${detail}). ` +
      'Falling back to the per-file mongodb-memory-server path as if nothing were reachable. If this is ' +
      'unexpected, check that global-setup.js ran successfully for CROWI_TEST_RUN_ID=' +
      `${process.env.CROWI_TEST_RUN_ID ?? '(unset)'} (feature-test-parallel-db-flake-hardening Phase 3 / B3-4).`,
  );
}

// The external Mongo URI that `global-setup.js` resolved once (the docker
// server, if reachable). Read from the sentinel file — a plain
// `process.env` read in `global-setup.js` (main process, pre-fork) DOES
// reliably reach every worker via `child_process.fork`'s env copy (see
// `test-mongo-sentinel.js`'s doc comment for the full jest-internals
// citation), but a file lets us tell "docker unreachable" (an intentionally
// empty sentinel) apart from "my own run's sentinel was never written" —
// see `getSentinelPath()`, which throws instead of resolving a stale or
// machine-shared path when `CROWI_TEST_RUN_ID` itself never propagated.
//
// Sentinel content (Phase 3 / B3-2, written by `global-setup.js`'s
// `writeSentinel()`): JSON `{ strategy, uri }` for EVERY branch WITHOUT
// EXCEPTION — including the `MONGO_URI` hard-override branch (`strategy:
// 'env-override'`, `uri: process.env.MONGO_URI`). An earlier revision had
// that branch write literal `''` and this function skip reading the
// sentinel entirely whenever `process.env.MONGO_URI` was set, on the theory
// that the env var was already authoritative — that exempted CI's MOST
// common shape (`services.mongo` sets `MONGO_URI` on every job) from ever
// having its sentinel validated at all, which is exactly backwards from the
// "a full green run proves every worker inherited a working sentinel" goal
// this file exists to provide. `readSentinelRecord()` below is now called
// UNCONDITIONALLY, on every branch, so a broken sentinel warns regardless of
// whether `MONGO_URI` happens to also be set. `strategy: 'memory-server'`
// (`uri: null`) is a LEGITIMATE recorded outcome (nothing reachable, or the
// CI guard blocked auto-detection) and must NOT warn — see the return
// statement below. Anything else that prevents extracting a `strategy`
// (missing file, empty content, invalid JSON, malformed shape) means this
// run's OWN sentinel is broken, which is exactly the "自分の run の
// sentinel を読めなかった" case Phase 3 / B3-4 requires a loud warn for, on
// every environment (not just CI) and on every branch (not just the
// non-`MONGO_URI` ones).
function readSentinelRecord(sentinelPath) {
  let raw;
  try {
    raw = fs.readFileSync(sentinelPath, 'utf8');
  } catch (err) {
    warnSentinelUnreadable(`sentinel file missing or unreadable at ${sentinelPath}: ${err.message}`);
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    // A blank read here (as opposed to a missing file, caught above) means
    // something wrote this run's sentinel without going through
    // `writeSentinel()`'s strategy-recording path (every branch always
    // writes a non-empty JSON record — see that function's doc comment) —
    // broken, not a legitimate empty-strategy state.
    warnSentinelUnreadable(`sentinel file at ${sentinelPath} was empty — expected a JSON {strategy, uri} record`);
    return undefined;
  }

  let record;
  try {
    record = JSON.parse(trimmed);
  } catch (err) {
    warnSentinelUnreadable(`sentinel file at ${sentinelPath} was not valid JSON (${err.message}): ${trimmed}`);
    return undefined;
  }

  if (!record || typeof record !== 'object' || typeof record.strategy !== 'string') {
    warnSentinelUnreadable(`sentinel file at ${sentinelPath} did not contain a recognizable {strategy, uri} record: ${trimmed}`);
    return undefined;
  }

  return record;
}

function resolvedExternalMongoUri() {
  // Resolve (and thereby assert) the sentinel path FIRST, on EVERY call —
  // including the `MONGO_URI` override branch below, which doesn't
  // strictly need the file's contents to pick its return value.
  // `getSentinelPath()` throws loudly when `CROWI_TEST_RUN_ID` never
  // propagated to this worker; an early `return` for the `MONGO_URI` branch
  // that skipped this call would silently exempt that whole code path from
  // the "a full suite passing proves every worker inherited the run id"
  // assertion this run-scoping exists to provide (A1-4 / AC9 in the design
  // doc) — and `MONGO_URI` is set on EVERY CI run (`services.mongo`), so
  // skipping it there would leave the assertion untested on exactly the
  // environment we most want it to cover. NOT inside the try/catch below:
  // an unset `CROWI_TEST_RUN_ID` is a broken-harness condition (env
  // propagation failure) and must throw loudly, not be swallowed into the
  // same silent-fallback path as "the sentinel file for my run doesn't
  // exist yet / isn't reachable".
  const sentinelPath = getSentinelPath();

  // Read + validate this run's OWN sentinel unconditionally, on EVERY
  // branch below — including `MONGO_URI` (Phase 3 rework: see this
  // function's module-level doc comment for why an earlier revision's
  // early-return before ever reading the sentinel was the wrong call).
  const record = readSentinelRecord(sentinelPath);

  if (process.env.MONGO_URI && process.env.MONGO_URI.trim()) {
    // `MONGO_URI` itself remains authoritative regardless of what the
    // sentinel recorded — env propagation to THIS worker is independent of
    // whether the sentinel file happens to be readable, so a broken
    // sentinel must not ALSO break a working `MONGO_URI` run; the
    // `readSentinelRecord()` call above already surfaced the
    // broken-harness warning as a side effect.
    return process.env.MONGO_URI;
  }

  if (!record) return undefined;

  // `memory-server` (or any other strategy recording a `null`/missing uri)
  // is a legitimately resolved outcome — NOT a "couldn't read my own
  // sentinel" failure — so it must not warn (that would spam every
  // no-infrastructure local run and every CI-guard invocation with a
  // warning that looks like a broken harness when nothing is actually
  // broken).
  return typeof record.uri === 'string' && record.uri.trim() ? record.uri : undefined;
}

/**
 * Post-splice self-check (Phase 3 / B3-1): `maxPoolSize=10` must actually be
 * present on `uri` after `buildPerFileUri()` (below) spliced it. This is
 * normally a no-op — `buildPerFileUri()` always sets the param right before
 * calling this — but ALL FOUR resolution paths (docker autodetect /
 * `MONGO_URI` override / `TEST_MONGO_URI` override / memory-server) funnel
 * through that ONE function, so asserting here is a single choke point that
 * would catch a future regression (e.g. a reordered `searchParams` call, or
 * swapping in a different URL builder) on every path at once, rather than
 * only on whichever path a human happens to be looking at when it breaks.
 * `serverSelectionTimeoutMS` / `connectTimeoutMS` are deliberately NOT
 * asserted — A1-3 never splices them (kept at the driver's 30000ms
 * default), so there is no invariant to check for those two params.
 */
function assertMaxPoolSizeSpliced(uri) {
  const value = new URL(uri).searchParams.get('maxPoolSize');
  if (value !== '10') {
    throw new Error(
      `[test-harness] crowi-environment: expected maxPoolSize=10 on the resolved test Mongo URI after buildPerFileUri() ` +
        `spliced it, but found ${JSON.stringify(value)} instead. This is a splice-logic bug, not a config problem — see ` +
        'feature-test-parallel-db-flake-hardening A1-3 / Phase 3 B3-1.',
    );
  }
}

/**
 * Splice the per-file db name onto `rawUri`'s pathname and cap
 * `maxPoolSize=10`, applied UNIFORMLY across every resolution path (docker
 * autodetect / `MONGO_URI` override / `TEST_MONGO_URI` override / the
 * in-process `mongodb-memory-server` fallback) — previously only the
 * autodetected docker candidate URIs got a pool cap (baked into
 * `global-setup.js`'s own URI constants), which left the `MONGO_URI`/
 * `TEST_MONGO_URI` override paths connecting with the driver's default
 * `maxPoolSize=100`.
 * Under `--maxWorkers=N` that is an N×100 simultaneous-connect burst
 * against one shared mongod, which can overflow the listen backlog and
 * surface as a transient `connect ETIMEDOUT` (see `global-setup.js`'s
 * `maxPoolSize=10` comment for the full rationale).
 *
 * `serverSelectionTimeoutMS` / `connectTimeoutMS` are deliberately NOT
 * touched here: this is the SAME connection the test file's own operations
 * keep reusing for the rest of its lifetime (not a short-lived probe), so
 * shortening its timeouts would turn a tolerable operation-level stall
 * into a new, unrelated failure class. See the design doc's A1-1/A1-3.
 *
 * Self-asserts the splice took (`assertMaxPoolSizeSpliced()` above,
 * Phase 3 / B3-1) before returning.
 */
function buildPerFileUri(rawUri, dbName) {
  const url = new URL(rawUri);
  url.pathname = `/${dbName}`;
  url.searchParams.set('maxPoolSize', '10');
  const result = url.toString();
  assertMaxPoolSizeSpliced(result);
  return result;
}

/**
 * Drop the database `mongoUri` points at, over a short-lived, capped
 * connection (`maxPoolSize=1` — one operation, then close;
 * `serverSelectionTimeoutMS=5000` — this only ever re-confirms a server a
 * `beforeAll` boot connection already proved reachable moments earlier, so
 * it doesn't need the driver's full 30000ms default). Extracted out of
 * `teardown()` below so a test can exercise the EXACT per-file-db drop
 * logic against a real Mongo server without instantiating the jest
 * `NodeEnvironment` machinery — see `crowi-environment.test.ts`.
 */
async function dropPerFileDatabase(mongoUri) {
  const mongoose = require('mongoose');
  const conn = await mongoose.createConnection(mongoUri, { maxPoolSize: 1, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    await conn.dropDatabase();
  } finally {
    // ALWAYS close, even when `dropDatabase()` throws — a connection left
    // open by a failed drop is a leaked socket that outlives this
    // function, on top of the drop failure itself (`teardown()`'s caller
    // already treats a `dropPerFileDatabase()` failure as non-fatal /
    // best-effort, so this doesn't change what the caller observes; it
    // only closes the connection that failure would otherwise leak).
    await conn.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Worker-side enrichment (feature-flake-failure-taxonomy AC-2/AC-3):
// `handleTestEvent` below, plus its pure classification helpers.
// ─────────────────────────────────────────────────────────────────────────

// MUST STAY IN SYNC with `op-ring-buffer.ts`'s exported `GLOBAL_KEY`
// constant — see that file's doc comment for why the two can't share an
// import (separate module systems: this file is plain CJS loaded outside
// jest's per-file Runtime, `op-ring-buffer.ts` is ts-jest-transformed and
// lives INSIDE the vm context this environment builds).
// `crowi-environment.test.ts`'s "RING_BUFFER_GLOBAL_KEY / op-ring-buffer.ts
// GLOBAL_KEY drift guard" test asserts the two literals are equal.
const RING_BUFFER_GLOBAL_KEY = '__crowiOpRingBuffer';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

// Matches Node's own connection-failure error message shape, e.g. `connect
// ETIMEDOUT 127.0.0.1:54321` / `connect ECONNREFUSED 127.0.0.1:54321` — the
// exact shape Supertest's client-side HTTP request against its own ephemeral
// `app.listen(0)` server produces when that connection never completes (see
// the spec's design section and `op-ring-buffer.ts`'s doc comment for why
// this failure never reaches `fetchFn`/the ring buffer at all).
const HOST_PORT_ERROR_PATTERN = /(?:ETIMEDOUT|ECONNREFUSED|ECONNRESET)\s+([^\s:]+):(\d+)/;

/** Walks `error.message`, then `error.cause.message`, etc. (bounded depth — this is a lightweight top-of-chain scan, not `db-connect-retry.ts`'s full `MongoServerSelectionError.reason.servers` unwrap, which exists specifically for the BOOT-connect path this module doesn't touch). */
function collectErrorMessages(error, depth = 3) {
  const messages = [];
  let node = error;
  let i = 0;
  while (node && typeof node === 'object' && i < depth) {
    if (typeof node.message === 'string') messages.push(node.message);
    node = node.cause;
    i += 1;
  }
  return messages;
}

/** Returns the FIRST host:port pair found in `messages` via `HOST_PORT_ERROR_PATTERN`, or `null` if none of them look like a connection failure at all. */
function extractHostPort(messages) {
  for (const message of messages) {
    const match = typeof message === 'string' ? message.match(HOST_PORT_ERROR_PATTERN) : null;
    if (match) return { host: match[1], port: Number(match[2]) };
  }
  return null;
}

/**
 * AC-3: decides whether a connection failure's `host:port` belongs to Mongo
 * or not by comparing it against THIS WORKER'S OWN resolved `MONGO_URI`
 * (`resolvedMongoUri`, `CrowiEnvironment#mongoUri` — set once in `setup()`
 * from whichever of docker/`MONGO_URI`/`TEST_MONGO_URI`/memory-server this
 * worker actually landed on) — never a hardcoded port. Both `docker-test`
 * (27018) and the in-process `mongodb-memory-server` (an OS-assigned dynamic
 * port) are equally valid "this IS Mongo" answers here; a bare "is it
 * 27017/27018" check would misclassify either the docker-dev fallback port
 * or a memory-server instance as `ephemeral`, and worse, could coincidentally
 * misclassify a genuinely ephemeral Supertest port that happens to land on
 * 27017/27018 as Mongo.
 *   - `'mongo'`: same port AND same (or loopback-equivalent) host as the
 *     resolved Mongo URI.
 *   - `'ephemeral'`: a loopback host that is NOT the resolved Mongo URI —
 *     Supertest's own local `http.Server` only ever binds loopback.
 *   - `'other'`: a non-loopback host that also isn't Mongo — unexpected;
 *     left for `classifyOpContext` to fall through to `unclassified` rather
 *     than guessed at here.
 *   - `null`: no host:port evidence at all (not a connection-failure shape).
 */
function classifyPortClass(hostPort, resolvedMongoUri) {
  if (!hostPort) return null;
  if (resolvedMongoUri) {
    try {
      const mongoUrl = new URL(resolvedMongoUri);
      const mongoPort = Number(mongoUrl.port) || 27017;
      const sameHost = hostPort.host === mongoUrl.hostname || (isLoopbackHost(hostPort.host) && isLoopbackHost(mongoUrl.hostname));
      if (hostPort.port === mongoPort && sameHost) return 'mongo';
    } catch {
      // resolvedMongoUri unparsable — fall through; can't positively confirm mongo.
    }
  }
  return isLoopbackHost(hostPort.host) ? 'ephemeral' : 'other';
}

/**
 * operationKind classification precedence (AC-2/AC-3; spec's "設計の主な判断"
 * §HTTP operation 相関). Pure — takes already-extracted inputs so it's
 * directly unit-testable without a real Circus event or ring buffer.
 *
 *   1. `portClass === 'ephemeral'` → `pre-dispatch`, `httpStatus: null`,
 *      `dispatched: false` — this error shape can only originate from
 *      Supertest's own client-to-ephemeral-server connection, which fails
 *      BEFORE `fetchFn`/the ring buffer ever observes the request (see
 *      `op-ring-buffer.ts`'s doc comment) — highest precedence because it is
 *      the most specific, unambiguous signal available.
 *   2. `portClass === 'mongo'` → `unit` — a genuine Mongo-level connectivity
 *      failure, not an HTTP dispatch outcome (whether it happened inside an
 *      HTTP handler or a direct Mongoose call in the test body).
 *   3. A ring-buffer entry recorded for THIS test → `http`, using that
 *      entry's `httpStatus` (itself possibly `null` if the app threw before
 *      producing a response — a DIFFERENT nullable-status cause than
 *      pre-dispatch: "dispatched but no status" vs. "never dispatched").
 *   4. No host:port evidence at all (`portClass === null`) and no matching
 *      ring-buffer entry → `unit` (e.g. a direct Mongoose assertion / E11000
 *      with no HTTP involved).
 *   5. Fallback → `unclassified` (e.g. `portClass === 'other'` with no
 *      matching ring-buffer entry — a connection failure against neither
 *      Mongo nor a loopback ephemeral port, an unexpected shape this
 *      taxonomy doesn't have enough evidence to name confidently).
 */
function classifyOpContext({ errorMessages, recentOps, testFullName, resolvedMongoUri }) {
  const hostPort = extractHostPort(errorMessages);
  const portClass = classifyPortClass(hostPort, resolvedMongoUri);

  const matchingOps = (recentOps || []).filter((op) => testFullName == null || op.testFullName === testFullName);
  const lastOp = matchingOps.length > 0 ? matchingOps[matchingOps.length - 1] : null;

  if (portClass === 'ephemeral') {
    return {
      operationKind: 'pre-dispatch',
      httpStatus: null,
      httpMethod: lastOp ? lastOp.method : null,
      httpPath: lastOp ? lastOp.path : null,
      portClass,
      dispatched: false,
    };
  }
  if (portClass === 'mongo') {
    return { operationKind: 'unit', httpStatus: null, httpMethod: null, httpPath: null, portClass, dispatched: false };
  }
  if (lastOp) {
    return { operationKind: 'http', httpStatus: lastOp.httpStatus, httpMethod: lastOp.method, httpPath: lastOp.path, portClass, dispatched: true };
  }
  if (portClass === null) {
    return { operationKind: 'unit', httpStatus: null, httpMethod: null, httpPath: null, portClass, dispatched: false };
  }
  return { operationKind: 'unclassified', httpStatus: null, httpMethod: null, httpPath: null, portClass, dispatched: false };
}

/** Circus `hook.type` → this taxonomy's `phase` field. `test_fn_failure`/`error` map to fixed phases below without consulting this. */
function phaseForEvent(event) {
  if (event.name === 'hook_failure') return `hook:${event.hook.type}`;
  if (event.name === 'test_fn_failure') return 'test';
  if (event.name === 'error') return 'unhandled';
  return 'unknown';
}

/** Normalizes whatever `error`-shaped value Circus attaches to an event — `jest-circus`'s own `_getError` (`utils.js`) tolerates non-`Error` thrown values, so this must too. */
function normalizeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return { name: typeof error.name === 'string' ? error.name : 'Error', message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}

/**
 * Reimplements `jest-circus`'s `getTestID` (space-joined ancestor titles,
 * `ROOT_DESCRIBE_BLOCK` excluded) against a Circus `test` (or `describeBlock`)
 * object, WITHOUT importing `jest-circus` — it is not resolvable from
 * `packages/api` (only `jest` itself is a direct dependency; `jest-circus` is
 * one of `jest`'s own transitive deps, not hoisted to a location this
 * package's plain `require` can reach under pnpm's strict layout). The join
 * format (`' '`, not `' > '`) matches `jestAdapterInit.js`'s
 * `expect.jestExpect.setState({ currentTestName: getTestID(event.test) })` —
 * i.e. it matches `expect.getState().currentTestName`, the SAME value
 * `op-ring-buffer.ts`'s `recordDispatchStart` tags each entry with — so ring
 * buffer entries correlate correctly against the identity computed here.
 */
function testFullNameFromCircusNode(node) {
  if (!node || typeof node !== 'object') return null;
  const parts = [];
  let current = node;
  while (current) {
    if (typeof current.name === 'string' && current.name !== 'ROOT_DESCRIBE_BLOCK') {
      parts.unshift(current.name);
    }
    current = current.parent;
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

const ERROR_MESSAGE_MAX_LENGTH = 2000;

/**
 * PURE core of `handleTestEvent` (the actual class method below is a thin
 * wrapper that gathers `this.*` context and calls this): given a Circus
 * event/state and this worker's own context (resolved Mongo URI, ring
 * buffer snapshot, test file path), returns the `kind: 'worker-enrichment'`
 * record to append, or `null` when the event isn't one this taxonomy cares
 * about. Separated out from the class method purely for direct unit-test
 * coverage without constructing a real Circus run.
 *
 * Listens to exactly the three Circus events that carry a failure this
 * taxonomy cares about (`hook_failure` / `test_fn_failure` / `error`) — see
 * `jest-circus`'s `eventHandler.js` for the full event catalogue; every
 * other event returns `null`. This is supplementary enrichment, NOT the
 * authoritative record (`failure-taxonomy-reporter.js` is — see that file's
 * doc comment): a worker that dies mid-test (the SIGSEGV case AC-1 exists
 * for) never reaches any of these handlers at all, by design.
 */
function buildWorkerEnrichmentRecord(event, state, workerContext) {
  if (event.name !== 'hook_failure' && event.name !== 'test_fn_failure' && event.name !== 'error') return null;

  const test = event.name === 'error' ? (state && state.currentlyRunningTest) || null : event.test || null;
  const phase = phaseForEvent(event);
  const { name: errorName, message: errorMessage } = normalizeError(event.error);
  const testFullName = testFullNameFromCircusNode(test) ?? testFullNameFromCircusNode(event.describeBlock);

  const opContext = classifyOpContext({
    errorMessages: collectErrorMessages(event.error),
    recentOps: workerContext.ringBuffer,
    testFullName,
    resolvedMongoUri: workerContext.mongoUri,
  });

  return {
    kind: 'worker-enrichment',
    testFilePath: workerContext.testFilePath || null,
    testFullName,
    phase,
    errorName,
    errorMessage: typeof errorMessage === 'string' ? errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH) : null,
    opContext,
  };
}

/**
 * jest environment for the @crowi/api server-side test project.
 *
 * Resolution order for the test MongoDB (this class only ever reads the
 * sentinel FILE that `global-setup.js` already resolved to one of these — it
 * does not re-decide between them; see that module's doc comment for the
 * full 5-segment priority (`MONGO_URI` > `TEST_MONGO_URI` >
 * `crowi-test-mongodb`:27018 > dev `mongodb`:27017 > memory-server). `CI ===
 * 'true'` is NOT a 6th segment — it's a gate that, only when `TEST_MONGO_URI`
 * is unset, blocks segments 3-4 (the un-overridden 27018/27017 auto-detect
 * cascade) so a CI runner never silently adopts a port it happens to have
 * something listening on instead of the `MONGO_URI` it was actually
 * configured with):
 *
 *   1. `process.env.MONGO_URI` is set → connect to that MongoDB directly
 *      (CI uses `services: mongo` on the GitHub Actions runner; local
 *      developers can point this at any MongoDB, including but not limited
 *      to the `docker compose up -d` ones below). This is a plain
 *      `process.env` read, not a sentinel read.
 *
 *   2. Otherwise, an external docker Mongo `global-setup.js` already probed
 *      and recorded in the run-scoped sentinel FILE (see
 *      `test-mongo-sentinel.js`) — once, in the jest main process before any
 *      worker forks, so no worker does its own racy probe. This covers
 *      THREE sub-cases — as of Phase 3 / B3-2 distinguishable from here via
 *      the sentinel's recorded `strategy` field (`env-override` /
 *      `docker-test` / `docker-dev`; see `resolvedExternalMongoUri()`'s doc
 *      comment for the full JSON shape), though `resolvedExternalMongoUri()`
 *      only ever hands this class the resolved `uri`, not the strategy
 *      label itself: an explicit `TEST_MONGO_URI` override, the dedicated
 *      tmpfs `crowi-test-mongodb` (port 27018, feature-test-parallel-db-flake-hardening
 *      Phase 2 / A2 — preferred, keeps full-suite churn off the always-on
 *      dev Mongo's disk path), or the dev `mongodb` service (port 27017,
 *      fallback when 27018 isn't reachable). A plain `pnpm test` with the
 *      docker stack up uses whichever of these `global-setup.js` picked, and
 *      avoids the per-file mongodb-memory-server churn that SIGSEGVs on full
 *      parallel runs. Each test file gets its own database under that
 *      server so jest can run `--maxWorkers=N` in parallel without
 *      collisions, and teardown drops the per-file db. `buildPerFileUri()`
 *      splices `maxPoolSize=10` onto whichever of these URIs is used, and
 *      self-asserts the splice took (Phase 3 / B3-1).
 *
 *   3. Otherwise (sentinel strategy is `memory-server` — nothing reachable,
 *      or `CI === 'true'` blocked auto-detection) → `mongodb-memory-server`
 *      is started in-process. This is the "no infrastructure" fallback for
 *      local `pnpm test` invocations on machines without the docker stack
 *      running. Each environment instance gets its own memory-server so
 *      there's no inter-file state. If the sentinel can't even be read/
 *      parsed at all (broken, not merely "empty" — Phase 3 / B3-4), this
 *      class also falls into this branch, but ONLY after `console.warn`ing
 *      loudly first (`warnSentinelUnreadable()`), on every environment —
 *      not just CI — instead of the silent fallback this replaced.
 *
 * Why per-test-file dbs instead of one shared db plus collection
 * clears: jest constructs a fresh `CrowiEnvironment` per test file
 * and `crowi.init()` registers mongoose models against the global
 * connection. Sharing a db across files lets one file's leftover
 * documents leak into the next file's `Model.find()` expectations.
 * Worker-scoped dbs aren't enough either — a single worker runs
 * many files serially. Random hex suffix per environment instance
 * is the cheapest way to guarantee isolation.
 */
class CrowiEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    // `NodeEnvironment`'s own constructor discards `context` (its `this.context`
    // is the vm context it creates, a different, pre-existing meaning) — capture
    // `context.testPath` ourselves so `handleTestEvent` (feature-flake-failure-taxonomy
    // AC-2) can tag its enrichment records with the file they came from.
    this.testFilePath = context && context.testPath;
  }

  /**
   * Jest Circus hook (`JestEnvironment#handleTestEvent`, see `@jest/environment`'s
   * type declaration) — `jest-circus`'s `jestAdapterInit.js` calls this
   * bound to the instance (`environment.handleTestEvent.bind(environment)`),
   * so `this` here is a real `CrowiEnvironment`. Gathers this worker's
   * context and delegates to the pure `buildWorkerEnrichmentRecord` above.
   *
   * Fail-open (AC-1/AC-2, feature-flake-failure-taxonomy): the entire body
   * is one `try`/`catch` that only ever `console.warn`s — an enrichment bug
   * must never affect (or mask) the real test run.
   */
  async handleTestEvent(event, state) {
    try {
      const record = buildWorkerEnrichmentRecord(event, state, {
        mongoUri: this.mongoUri,
        testFilePath: this.testFilePath,
        ringBuffer: this.global && Array.isArray(this.global[RING_BUFFER_GLOBAL_KEY]) ? this.global[RING_BUFFER_GLOBAL_KEY] : [],
      });
      if (!record) return;
      const runId = failureTaxonomyChannel.currentRunId();
      failureTaxonomyChannel.appendRecord(runId, record);
    } catch (err) {
      // Fail-open — see this method's doc comment.
      console.warn(`[test-harness] crowi-environment: handleTestEvent enrichment failed (${err.message}).`);
    }
  }

  async setup() {
    await super.setup();

    // Provide a stable encryption key for the test environment so
    // (a) the boot path's "legacy mode" warning doesn't spam test
    // output, and (b) sensitive Config round-trips exercise the
    // real encrypt/decrypt code path rather than the plaintext
    // fallback. Tests that specifically need the unconfigured state
    // (e.g. `crypto.test.ts`) save `originalKey`, mutate, and
    // restore — so providing a default here is safe.
    //
    // Mutate `this.global.process.env`, NOT the host's `process.env`:
    // jest-environment-node hands the test vm context a `process` that
    // doesn't share its `env` proxy with the worker host, so an
    // assignment to host `process.env` here is invisible to the test
    // code that boots `Crowi` from within the vm.
    if (!this.global.process.env.CROWI_ENCRYPTION_KEY) {
      this.global.process.env.CROWI_ENCRYPTION_KEY = Buffer.alloc(32, 0xab).toString('base64');
    }

    const workerId = process.env.JEST_WORKER_ID || '1';
    const suffix = randomBytes(4).toString('hex');
    const dbName = `crowi_test_${workerId}_${suffix}`;

    const externalUri = resolvedExternalMongoUri();
    if (externalUri && externalUri.trim()) {
      // Strip any trailing path / db / query on the supplied URI, splice in
      // our per-file db name, and cap the pool. `mongodb://localhost:27017/
      // foo?bar` becomes `mongodb://localhost:27017/crowi_test_<id>?bar&
      // maxPoolSize=10`.
      this.mongoUri = buildPerFileUri(externalUri, dbName);
      this.dbName = dbName;
      this.usingMemoryServer = false;
    } else if (process.env.CI === 'true') {
      // Fail fast: CI is supposed to provide a real mongo via the
      // workflow's services.mongo + env.MONGO_URI. If we reach this
      // branch in CI, env propagation broke for this jest worker —
      // silently falling back to mongodb-memory-server here races on
      // a shared binary-download lockfile under --maxWorkers=N and
      // shows up as the cryptic "Cannot unlock file ... not locked
      // by this process". Surface the actual missing-env state
      // instead.
      const envKeys = Object.keys(process.env).sort();
      // Print the actual value (or `null` for unset) so we can tell
      // "key propagated but blank" from "key didn't propagate at all"
      // — same surface error for both, but very different root causes.
      throw new Error(
        'crowi-environment: MONGO_URI was empty inside a CI run. ' +
          'mongodb-memory-server is intentionally not a CI fallback ' +
          '(see services.mongo + env.MONGO_URI in .github/workflows/ci.yml). ' +
          `Diagnostic: workerId=${process.env.JEST_WORKER_ID || '(none)'} ` +
          `MONGO_URI=${JSON.stringify(process.env.MONGO_URI ?? null)} ` +
          `CI=${JSON.stringify(process.env.CI ?? null)} ` +
          `envCount=${envKeys.length} envMongoKeys=${envKeys.filter((k) => k.startsWith('MONGO')).join(',') || '(none)'}.`,
      );
    } else {
      // No external Mongo and no docker server reachable (global-setup.js
      // would have set MONGO_URI otherwise): spin up an in-process
      // memory-server. This is the "no infrastructure" fallback for
      // machines without the docker stack. Pin to 8.0.4 so the binary
      // matches the `mongo:8.0.4` docker image used in CI's `services`
      // block — keeps wire-protocol + index behaviour byte-identical
      // between the two execution paths so we don't get "passes locally,
      // fails in CI" mismatches from minor MongoDB version drift.
      // NOTE: under `--maxWorkers=N` this path spawns a mongod per file
      // and can SIGSEGV on large runs; prefer `docker compose up -d`
      // (auto-detected by global-setup.js) for full runs.
      const { MongoMemoryServer } = require('mongodb-memory-server');
      this.memory = await MongoMemoryServer.create({ binary: { version: '8.0.4' } });
      this.mongoUri = buildPerFileUri(this.memory.getUri(), dbName);
      this.dbName = dbName;
      this.usingMemoryServer = true;
    }

    this.global.MONGO_URI = this.mongoUri;
    this.global.MONGO_DB_NAME = this.dbName;
    this.global.ROOT_DIR = ROOT_DIR;
    this.global.MODEL_DIR = MODEL_DIR;
  }

  async teardown() {
    // Drop the per-file db on a shared (docker / CI) server so the
    // mongo instance doesn't accumulate stale dbs across runs. Use
    // mongoose since the api package already depends on it — avoids
    // adding a direct `mongodb` driver dependency just for cleanup.
    // Best-effort: if setup() bailed before connection, just skip.
    if (this.mongoUri) {
      try {
        await dropPerFileDatabase(this.mongoUri);
      } catch (_err) {
        // Cleanup failure is non-fatal; memory-server stop below
        // handles ephemeral storage, and a stale db on the shared
        // server only costs disk until the next run drops it.
      }
    }
    if (this.usingMemoryServer && this.memory) {
      await this.memory.stop();
    }
    await super.teardown();
  }
}

module.exports = CrowiEnvironment;

// Test-only hooks (see `crowi-environment.test.ts`): attached as static
// properties rather than separate named exports so jest's `testEnvironment`
// resolution (`require(path).default || require(path)`, expecting either a
// class or a `{ default: class }` shape) keeps working unmodified — the
// class itself IS `module.exports` either way, and a function/class is a
// perfectly normal place to hang extra static properties in JS.
CrowiEnvironment.__test__ = {
  buildPerFileUri,
  resolvedExternalMongoUri,
  dropPerFileDatabase,
  assertMaxPoolSizeSpliced,
  // feature-flake-failure-taxonomy AC-2/AC-3 classification helpers:
  classifyPortClass,
  classifyOpContext,
  testFullNameFromCircusNode,
  buildWorkerEnrichmentRecord,
  RING_BUFFER_GLOBAL_KEY,
};
