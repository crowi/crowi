const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Run-scoped JSON Lines side channel for the failure taxonomy measurement
// pipeline (feature-flake-failure-taxonomy). Bridges THREE writers that
// cannot otherwise share JS state, each loaded through a different module
// system within the same jest invocation:
//
//   - `failure-taxonomy-reporter.js` (the jest MAIN process, loaded via
//     jest's own reporter bootstrapping — plain `require`, no jest Runtime).
//     Writes the AUTHORITATIVE `kind: 'authoritative-file-result'` row for
//     every non-pass test file (AC-1).
//   - `crowi-environment.js`'s `handleTestEvent` (a WORKER process, also
//     loaded via plain `require`, outside jest's per-file Runtime/ts-jest
//     module registry). Writes `kind: 'worker-enrichment'` rows (AC-2/AC-3).
//   - `op-ring-buffer.ts` does NOT write here directly — it lives INSIDE the
//     vm context ts-jest sets up for the test file (imported by `setup.ts`),
//     a third, separate module registry. Its data instead crosses into
//     `handleTestEvent` via `this.global.__crowiOpRingBuffer` (see that
//     file's doc comment) and is folded into the SAME worker-enrichment row
//     `handleTestEvent` writes here — there is no reason for the ring
//     buffer to touch this channel on its own.
//
// This is a NEW, independent channel — it deliberately does NOT read or
// piggyback on `CROWI_TEST_RUN_ID` (the existing near-miss channel's run id,
// `db-connect-retry.ts` / `test-mongo-sentinel.js`): that id can be pre-set
// by an unrelated external caller for a DIFFERENT purpose (e.g.
// `scripts/test-flake-report.mjs` sets it to correlate the near-miss
// channel with the run IT orchestrates), and reusing it here would let two
// unrelated measurement sessions collide on one shared id ("併走で混ざる" —
// see the spec's design section). `RUN_ID_ENV_VAR` below is 100% dedicated
// to this feature.
//
// Rigor level (spec: "db-connect-retry.ts の near-miss channel と同水準の
// 厳密さ" — and beyond it in a few ways the near-miss channel doesn't need):
//   - per-invocation FRESH run id, generated the same `pid + base36
//     timestamp` way `global-setup.js` seeds `CROWI_TEST_RUN_ID` (that
//     formula is cited by this feature's task as a reusable precedent), but
//     via its own dedicated env var (`ensureRunId()` below).
//   - EXCLUSIVE (`O_EXCL`) first-create of this run's event file
//     (`ensureChannelFileCreated`) — proves no other run ever wrote to this
//     exact path before. A second-or-later writer racing to create the SAME
//     run's file is an expected, benign peer (the reporter in the parent
//     process and every worker all share one run id), not evidence of a
//     foreign/stale collision — see that function's doc comment.
//   - ATOMIC one-record-per-line append (`fs.appendFileSync`'s `'a'` flag is
//     `O_APPEND`; POSIX guarantees a single `write()` under `PIPE_BUF` can
//     never interleave with a concurrent writer's `write()`, only race on
//     ordering — safe for the parent reporter and N workers appending to the
//     same file concurrently).
//   - VERSIONED schema (`schemaVersion`) and REJECTION of foreign/stale rows
//     on read (`readChannel`) — a row whose `runId` doesn't match the
//     caller's expected run id, or whose `schemaVersion` isn't recognized,
//     is skipped with a warning rather than silently accepted or thrown.
//   - CLEANUP: `cleanupChannel()` is the consuming orchestrator's
//     responsibility (see below), not automatic — `failure-taxonomy-reporter.js`
//     deliberately does NOT delete the file itself in `onRunComplete`,
//     because `scripts/test-flake-taxonomy.mjs` (AC-5's N-run aggregator)
//     needs to read this run's channel file AFTER the spawned jest process
//     has already exited; deleting it from inside that same process would
//     make it vanish before the aggregator ever gets to read it. A bare
//     `pnpm --filter @crowi/api test` (no aggregator) leaves the file behind
//     in `os.tmpdir()` — the same accepted tradeoff `db-connect-retry.ts`'s
//     near-miss channel already makes.
//
// Fail-open (AC-1/AC-2: "計測失敗がテストを落とさない") is enforced by
// EVERY CALLER of this module, not by this module itself: `currentRunId()`
// throws loudly when the env var never propagated (a genuine broken-harness
// signal, matching `db-connect-retry.ts`'s `resolveRetryEventsPath()` /
// `test-mongo-sentinel.js`'s `getSentinelPath()` precedent), and
// `appendRecord()` propagates any I/O error instead of swallowing it. Both
// `failure-taxonomy-reporter.js` and `crowi-environment.js`'s
// `handleTestEvent` wrap their calls into this module in a `try`/`catch`
// that only ever `console.warn`s — a measurement-layer failure here must
// never surface as (or mask) a real test failure.

const RUN_ID_ENV_VAR = 'CROWI_FAILURE_TAXONOMY_RUN_ID';
const SCHEMA_VERSION = 1;

/** Same `pid + base36 timestamp` shape as `global-setup.js`'s `CROWI_TEST_RUN_ID` seed, plus a short random suffix (this channel has no fork-timing guarantee to lean on the way that one does — see `ensureRunId()`). */
function generateRunId() {
  return `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Idempotent seed, mirroring `global-setup.js`'s `process.env.CROWI_TEST_RUN_ID
 * ??= ...` pattern (cited by this feature's task as a reusable formula):
 * `??=` rather than an unconditional overwrite so an external orchestrator —
 * `scripts/test-flake-taxonomy.mjs`, spawning `pnpm --filter @crowi/api test`
 * (or `pnpm test` through turbo, co-scheduled with every other workspace)
 * once per N-run iteration — can pre-set a FRESH id per spawn and know ahead
 * of time which channel file that invocation will write to, exactly the way
 * `scripts/test-flake-report.mjs` pre-sets `CROWI_TEST_RUN_ID` for the
 * near-miss channel today. A bare `pnpm --filter @crowi/api test` (no
 * orchestrator) leaves the env var unset, so this self-generates — same
 * dual-mode contract as `CROWI_TEST_RUN_ID`.
 *
 * Called ONCE, by `failure-taxonomy-reporter.js`'s constructor, which jest
 * always instantiates in the MAIN process before any worker is forked (see
 * that file's doc comment for the `@jest/core` call-order citation) — so
 * every forked worker inherits the resulting value via `child_process.fork`'s
 * env copy, the same fork-timing guarantee `test-mongo-sentinel.js` relies on.
 */
function ensureRunId() {
  if (!process.env[RUN_ID_ENV_VAR] || !process.env[RUN_ID_ENV_VAR].trim()) {
    process.env[RUN_ID_ENV_VAR] = generateRunId();
  }
  return process.env[RUN_ID_ENV_VAR];
}

/**
 * Reads the already-established run id. Throws loudly (does NOT self-generate)
 * when unset — every worker-side caller should have inherited it from
 * `ensureRunId()`'s parent-process assignment; an unset value here means that
 * propagation broke, which is a signal worth surfacing (via the caller's
 * fail-open `catch`), not a state to silently paper over with a fresh,
 * un-correlated id of its own.
 */
function currentRunId() {
  const runId = process.env[RUN_ID_ENV_VAR];
  if (!runId || !runId.trim()) {
    throw new Error(
      `[test-harness] failure-taxonomy-channel: ${RUN_ID_ENV_VAR} is unset. failure-taxonomy-reporter.js's constructor ` +
        'should have generated it (in the jest MAIN process, before any worker forked) via ensureRunId(). Every caller of ' +
        "this module MUST catch this and fail open — see this module's doc comment.",
    );
  }
  return runId;
}

/**
 * `os.tmpdir()` resolves `process.env.TMPDIR` (on macOS/Linux) at CALL time —
 * every writer/reader of this channel must therefore run with the SAME
 * `TMPDIR` for their independently-computed paths to agree. This bit a real
 * run during this feature's own Phase 0 evidence gathering: turbo's task
 * execution sandboxes env vars down to `turbo.json`'s `globalPassThroughEnv`
 * (now listing `TMPDIR` explicitly for this reason), and `scripts/test-flake-taxonomy.mjs`
 * additionally pins `TMPDIR` itself on the env it spawns children with — see
 * that script's `runOnce()` doc comment for the full incident writeup
 * (a `turbo run test` iteration wrote its channel file to plain `/tmp/...`
 * while the orchestrating script's own `os.tmpdir()` — inherited from a
 * normal shell, NOT turbo's sandboxed env — resolved to a per-session
 * `/var/folders/.../T/...` path, so the aggregator silently never found a
 * real, correctly-recorded failure).
 */
function resolveChannelPath(runId) {
  return path.join(os.tmpdir(), `crowi-api-test-failure-taxonomy.${runId}.jsonl`);
}

/**
 * Exclusive (`O_EXCL`) first-create of this run's event file. `EEXIST` is
 * swallowed — NOT evidence of a foreign/stale collision, just a peer writer
 * (the parent reporter or another worker sharing this same run id) that won
 * the race to create it first, which is the expected, common case once more
 * than one process holds this run's id. Any OTHER error propagates.
 */
function ensureChannelFileCreated(filePath) {
  try {
    fs.closeSync(fs.openSync(filePath, 'wx'));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/** Appends one record (with the versioned envelope fields folded in) as a single atomic JSON line. Throws on I/O failure — see this module's fail-open doc comment for why callers must catch. */
function appendRecord(runId, record) {
  const filePath = resolveChannelPath(runId);
  ensureChannelFileCreated(filePath);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    recordedAt: new Date().toISOString(),
    ...record,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(envelope)}\n`);
}

/**
 * Reads and parses `runId`'s channel file, rejecting foreign/stale/malformed
 * rows (AC-4) instead of throwing or silently accepting them:
 *   - a line that isn't valid JSON, or isn't an object shaped like a record
 *     (no string `kind`) — malformed.
 *   - `schemaVersion` isn't the version this reader understands — stale
 *     writer / format drift.
 *   - `runId` on the row doesn't match the caller's expected `runId` — a
 *     foreign row (should be structurally impossible given the run-scoped
 *     path, but rejected defensively rather than trusted blindly).
 * Each rejection is collected as a warning string, mirroring
 * `scripts/test-flake-report.mjs`'s `parseNearMissJsonl` — a single bad row
 * must not take down the whole read. Returns `existed: false` (not an
 * error) when the file was never created at all (e.g. a run with zero
 * non-pass files never gets a channel file — nothing to clean up either).
 */
function readChannel(runId) {
  const filePath = resolveChannelPath(runId);
  const records = [];
  const warnings = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { records, warnings, filePath, existed: false };
    throw err;
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warnings.push(`could not parse a failure-taxonomy channel line as JSON (${err.message}): ${line}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
      warnings.push(`skipped a malformed failure-taxonomy channel row (no recognizable "kind"): ${line}`);
      continue;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      warnings.push(`skipped a failure-taxonomy channel row with an unrecognized schemaVersion (${JSON.stringify(parsed.schemaVersion)}): ${line}`);
      continue;
    }
    if (parsed.runId !== runId) {
      warnings.push(`skipped a foreign failure-taxonomy channel row (runId ${JSON.stringify(parsed.runId)} !== expected ${JSON.stringify(runId)})`);
      continue;
    }
    records.push(parsed);
  }
  return { records, warnings, filePath, existed: true };
}

/**
 * Best-effort removal of `runId`'s channel file. The CONSUMING orchestrator's
 * job (`scripts/test-flake-taxonomy.mjs` calls this once per N-run iteration,
 * right after reading) — see this module's doc comment for why
 * `failure-taxonomy-reporter.js` must NOT do this itself.
 */
function cleanupChannel(runId) {
  try {
    fs.rmSync(resolveChannelPath(runId), { force: true });
  } catch {
    // best-effort — a leftover file only costs disk (each run's own id
    // keeps its path from colliding with any other run's).
  }
}

module.exports = {
  RUN_ID_ENV_VAR,
  SCHEMA_VERSION,
  generateRunId,
  ensureRunId,
  currentRunId,
  resolveChannelPath,
  ensureChannelFileCreated,
  appendRecord,
  readChannel,
  cleanupChannel,
};
