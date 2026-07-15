#!/usr/bin/env node
// `pnpm test:flake-taxonomy` — N-run baseline taxonomy aggregator for
// `@crowi/api`'s full jest suite (feature-flake-failure-taxonomy AC-5).
//
// Repeats the full suite N times — both STANDALONE (`pnpm --filter
// @crowi/api test`, the same direct-spawn shape `scripts/test-flake-report.mjs`
// already uses and this script's `spawnStandaloneApiTest` reuses) and, per
// the spec's open question Q1, under ROOT `pnpm test`'s turbo-concurrency=3
// co-schedule load (every other workspace's own test suite running
// alongside `@crowi/api`'s, the same load shape CI's `test` job produces —
// standalone alone doesn't reproduce that) — and aggregates every run's
// `failure-taxonomy-channel.js` records into class-by-class counts, one
// `repro` example per observed class, and an `unclassified` bucket (counted
// like any other class, not a separate structure — see `classNameForRecord`
// below).
//
// This is a MEASUREMENT tool only (AC-6: no remedy, no product-code touch).
// It reads `@crowi/api`'s own reporter/enrichment channel — it does not
// change how any test runs.
//
// ── how it locates the channel file for each spawned jest process ──
//
// `failure-taxonomy-channel.js`'s `ensureRunId()` is `??=`-idempotent (like
// `global-setup.js`'s `CROWI_TEST_RUN_ID ??= ...` seed) specifically so an
// external orchestrator can pre-set `CROWI_FAILURE_TAXONOMY_RUN_ID` in the
// child's env BEFORE spawning and know ahead of time which channel file
// that invocation's reporter will write to — the exact pattern
// `scripts/test-flake-report.mjs` already uses for `CROWI_TEST_RUN_ID` /
// the near-miss channel. This script generates one FRESH id per iteration
// (never reused across iterations — see `runOnce` below) and forwards it as
// `CROWI_FAILURE_TAXONOMY_RUN_ID` in the spawned child's env; through turbo
// (the "turbo" mode) this additionally requires `turbo.json`'s
// `globalPassThroughEnv` to list that var (added alongside `MONGO_URI` /
// `TEST_MONGO_URI` / etc.), or turbo's env sandboxing would strip it before
// the nested `@crowi/api` jest process ever sees it.
//
// Channel records are NOT imported from `packages/api/src/test/` — that
// tree is ts-jest/CJS inside a different package with no shared npm
// package; this script duplicates the read-side parsing/rejection logic
// (`parseChannelJsonl` below), mirroring the SAME "protocol-identical but
// deliberately duplicated" choice `scripts/test-flake-report.mjs` already
// makes for the near-miss channel. Keep the two in sync if either the
// schema or `failure-taxonomy-channel.js`'s `readChannel` changes.
//
// ── cleanup ──
//
// AC-4 requires "実行後 cleanup" — this script IS that consumer: it reads
// each iteration's channel file immediately after that iteration's spawn
// exits, then deletes it (`rmSync`) before starting the next iteration, so
// a run's channel can never bleed into the next run's count even if two
// iterations' ids somehow collided. `failure-taxonomy-reporter.js`
// deliberately does NOT delete the file itself — see that file's doc
// comment for why (this script needs to read it after the process exits).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RUN_ID_ENV_VAR = 'CROWI_FAILURE_TAXONOMY_RUN_ID'
const SCHEMA_VERSION = 1

// ── pure helpers (covered by test-flake-taxonomy.test.mjs) ──

/** Same `pid + base36 timestamp + short random suffix` shape as `failure-taxonomy-channel.js`'s `generateRunId()` — deliberately duplicated, see this module's doc comment. */
export function generateRunId() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Independent duplicate of `failure-taxonomy-channel.js`'s `resolveChannelPath()` path formula. */
export function resolveChannelPath(runId) {
  return path.join(tmpdir(), `crowi-api-test-failure-taxonomy.${runId}.jsonl`)
}

/**
 * Independent duplicate of `failure-taxonomy-channel.js`'s `readChannel()`
 * row-rejection logic (malformed JSON / unrecognized schemaVersion / foreign
 * runId) — takes already-read file content rather than doing its own I/O so
 * it's directly unit-testable. See this module's doc comment for why this
 * isn't imported.
 */
export function parseChannelJsonl(content, expectedRunId) {
  const records = []
  const warnings = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      warnings.push(`could not parse a failure-taxonomy channel line as JSON (${err.message}): ${line}`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
      warnings.push(`skipped a malformed failure-taxonomy channel row (no recognizable "kind"): ${line}`)
      continue
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      warnings.push(`skipped a failure-taxonomy channel row with an unrecognized schemaVersion (${JSON.stringify(parsed.schemaVersion)}): ${line}`)
      continue
    }
    if (parsed.runId !== expectedRunId) {
      warnings.push(`skipped a foreign failure-taxonomy channel row (runId ${JSON.stringify(parsed.runId)} !== expected ${JSON.stringify(expectedRunId)})`)
      continue
    }
    records.push(parsed)
  }
  return { records, warnings }
}

/**
 * Sub-classifies ONE authoritative (`kind: 'authoritative-file-result'`)
 * record into the taxonomy's class-count buckets, using its matching
 * `worker-enrichment` records (same `testFilePath`) as supplementary
 * evidence when the file isn't a worker-crash/exec-error (AC-5: "evidence
 * で観測された class のみを assert し、未実証 class を先回りで立てない" —
 * this function does not hardcode "JWT-401" / "E11000 path_1"; it only ever
 * names a class from what the record itself actually carries).
 *   - `hasExecError` (AC-1's "signal or 欠落結果" case): named from
 *     `workerCrash.kind`/`signal` when recognized, else the generic
 *     `exec-error:unclassified` bucket — still correctly bucketed as an
 *     exec-error even when the specific cause isn't one of the two known
 *     `jest-worker` message shapes.
 *   - Otherwise (a normal per-assertion failure, worker alive): the richest
 *     matching enrichment record's `opContext.operationKind` names the
 *     class (`pre-dispatch-timeout` / `mongo-op-failure` / `unit-failure` /
 *     `http-status-mismatch:expected-<E>-received-<R>` when the failure
 *     message is a `toBe`-shaped HTTP status assertion — see
 *     `HTTP_STATUS_MISMATCH_PATTERN` below — else the more generic
 *     `http-assertion-failure:<status>`, falling back to the ring buffer's
 *     LAST recorded op for that test, which is only a "recent context" best
 *     guess, NOT necessarily the exact request the failing assertion made —
 *     see `op-ring-buffer.ts`'s doc comment).
 *   - No usable evidence either way → `'unclassified'` (AC-5's bucket —
 *     just another entry in the same counts map, not a special structure).
 */
const HTTP_STATUS_MISMATCH_PATTERN = /Expected: (\d{3})\s*\n\s*Received: (\d{3})/

function isPlausibleHttpStatus(n) {
  return Number.isInteger(n) && n >= 100 && n <= 599
}

export function classNameForRecord(record, matchingEnrichment) {
  if (record.hasExecError) {
    const crash = record.workerCrash
    if (crash && crash.kind === 'worker-terminated') return `worker-crash:${crash.signal ?? 'unknown-signal'}`
    if (crash && crash.kind === 'worker-crashed') return 'worker-crash:unknown-exit'
    if (crash && crash.kind === 'worker-oom') return 'worker-crash:oom'
    return 'exec-error:unclassified'
  }

  const withOpContext = matchingEnrichment.find((e) => e.opContext && e.opContext.operationKind && e.opContext.operationKind !== 'unclassified')
  if (withOpContext) {
    const { operationKind, portClass, httpStatus } = withOpContext.opContext
    if (operationKind === 'pre-dispatch') return 'pre-dispatch-timeout'
    if (operationKind === 'unit' && portClass === 'mongo') return 'mongo-op-failure'
    if (operationKind === 'unit') return 'unit-failure'
    if (operationKind === 'http') {
      // Prefer the ACTUAL expected/received pair from the assertion message
      // (e.g. `expect(res.status).toBe(200)` failing with a 401) over the
      // ring buffer's last-recorded httpStatus — in a multi-request test
      // (AC-2's "1 test 内の複数並列 request") that last entry can be a
      // DIFFERENT, unrelated, successfully-dispatched request, which would
      // otherwise mislabel e.g. a 401-vs-200 mismatch as
      // `http-assertion-failure:200` (misleadingly naming it after the
      // wrong request's status).
      const mismatch = typeof record.failureMessageExcerpt === 'string' ? record.failureMessageExcerpt.match(HTTP_STATUS_MISMATCH_PATTERN) : null
      if (mismatch) {
        const expected = Number(mismatch[1])
        const received = Number(mismatch[2])
        if (isPlausibleHttpStatus(expected) && isPlausibleHttpStatus(received)) {
          return `http-status-mismatch:expected-${expected}-received-${received}`
        }
      }
      return `http-assertion-failure:${httpStatus ?? 'unknown-status'}`
    }
  }
  return 'unclassified'
}

/** Joins every authoritative record in ONE run's already-filtered records with its matching enrichment record(s) and names a class for each. Pure. */
export function classifyRunRecords(records) {
  const authoritative = records.filter((r) => r.kind === 'authoritative-file-result')
  const enrichment = records.filter((r) => r.kind === 'worker-enrichment')

  return authoritative.map((record) => {
    const matchingEnrichment = enrichment.filter((e) => e.testFilePath === record.testFilePath)
    return { ...record, className: classNameForRecord(record, matchingEnrichment), matchingEnrichment }
  })
}

/** Folds every run's `classifiedRecords` into `{ counts, repro }` — `counts[class]` is the total occurrence count across ALL runs, `repro[class]` is the FIRST observed record of that class (a concrete example for the evidence writeup). Pure. */
export function aggregateClasses(runs) {
  const counts = {}
  const repro = {}
  for (const run of runs) {
    for (const record of run.classifiedRecords) {
      counts[record.className] = (counts[record.className] ?? 0) + 1
      if (!repro[record.className]) repro[record.className] = { runId: run.runId, mode: run.mode, ...record }
    }
  }
  return { counts, repro }
}

// ── glue (spawns real child processes — not covered by the unit tests, same
// precedent as `test-flake-report.mjs`'s untested `main()`) ──

function spawnStandaloneApiTest(env) {
  // Same no-literal-`--` reasoning as `test-flake-report.mjs`'s `spawnApiTest`
  // — not relevant here (no extra jest flags are forwarded), kept for
  // consistency with that script's spawn shape.
  return spawnSync('pnpm', ['--filter', '@crowi/api', 'test'], { cwd: repoRoot, stdio: 'inherit', env })
}

function spawnTurboCoScheduleApiTest(env) {
  // The SAME command root `pnpm test` runs (`turbo run test --concurrency=3`
  // — every workspace's own test suite alongside `@crowi/api`'s, reproducing
  // the load shape CI's `test` job produces, Q1: "standalone は CI 失敗モー
  // ドを再現しない") — invoked as `npx turbo ...` DIRECTLY rather than via
  // `pnpm test`, and with `--force` appended.
  //
  // Both of these are load-bearing, confirmed the hard way during this
  // feature's own Phase 0 evidence gathering:
  //   - `--force` is REQUIRED: turbo caches a task's result by content hash,
  //     and NOTHING about any workspace's source changes between N
  //     consecutive iterations of this same command within one baseline
  //     session — without it, iteration 2..N are each an instant cache
  //     REPLAY of iteration 1 (`Cached: 36 cached, 36 total` / `142ms >>>
  //     FULL TURBO` on every one of a first 5-"run" attempt — zero real
  //     re-executions past the first), silently turning an N-run baseline
  //     into a 1-run baseline repeated N times.
  //   - Going through `pnpm test -- --force` (letting pnpm forward the extra
  //     arg into the `turbo run test --concurrency=3` script) does NOT work
  //     as expected: a second attempt that way had turbo forward `--force`
  //     itself down into EVERY task's underlying command too (e.g.
  //     `jest --passWithNoTests --force`, which `jest` rejects outright as
  //     an "Unrecognized CLI Parameter", failing every workspace's test
  //     task). Invoking `turbo` directly (bypassing pnpm's script-argv
  //     indirection) does not have this problem — `--force` is consumed by
  //     turbo itself, as confirmed by `npx turbo run test --concurrency=3
  //     --force --dry=json` showing 0 cache hits.
  return spawnSync('npx', ['turbo', 'run', 'test', '--concurrency=3', '--force'], { cwd: repoRoot, stdio: 'inherit', env })
}

/** One full-suite invocation: spawns it with a fresh run id, reads + classifies that run's channel, then deletes the channel file (AC-4 cleanup) before returning. */
function runOnce(mode) {
  const runId = generateRunId()
  // `TMPDIR` is pinned explicitly, not just inherited via `...process.env` —
  // discovered the hard way: turbo's task execution sandboxes env vars to
  // `globalPassThroughEnv` (that's WHY `CROWI_FAILURE_TAXONOMY_RUN_ID` is
  // listed there), and on macOS `os.tmpdir()` falls back to plain `/tmp`
  // when `TMPDIR` isn't set — DIFFERENT from this process's own real
  // `TMPDIR` (typically a per-session `/var/folders/.../T` path). Without
  // pinning it, a turbo-mode run's `failure-taxonomy-reporter.js` would
  // write its channel file to `/tmp/...` while THIS script's own
  // `resolveChannelPath()` (same formula, but evaluated in THIS process,
  // which sees the real `TMPDIR`) looks for it at the wrong path — a
  // channel write that silently vanishes from the aggregate (`turbo.json`'s
  // `globalPassThroughEnv` now also lists `TMPDIR` as defense in depth for
  // anyone running `pnpm test` directly without going through this script).
  const env = { ...process.env, [RUN_ID_ENV_VAR]: runId, TMPDIR: tmpdir() }
  const spawn = mode === 'standalone' ? spawnStandaloneApiTest : spawnTurboCoScheduleApiTest
  const spawnResult = spawn(env)

  const channelPath = resolveChannelPath(runId)
  let records = []
  let warnings = []
  if (existsSync(channelPath)) {
    const { records: parsedRecords, warnings: parseWarnings } = parseChannelJsonl(readFileSync(channelPath, 'utf8'), runId)
    records = parsedRecords
    warnings = parseWarnings
    rmSync(channelPath, { force: true })
  }

  return { runId, mode, exitCode: spawnResult.status ?? null, classifiedRecords: classifyRunRecords(records), warnings }
}

function parseArgs(argv) {
  let standaloneRuns = 20
  let turboRuns = 5
  for (const arg of argv) {
    const standaloneMatch = arg.match(/^--standalone-runs=(\d+)$/)
    if (standaloneMatch) standaloneRuns = Number(standaloneMatch[1])
    const turboMatch = arg.match(/^--turbo-runs=(\d+)$/)
    if (turboMatch) turboRuns = Number(turboMatch[1])
  }
  return { standaloneRuns, turboRuns }
}

function main() {
  const { standaloneRuns, turboRuns } = parseArgs(process.argv.slice(2))
  const runs = []

  for (let i = 0; i < standaloneRuns; i++) {
    process.stderr.write(`[test-flake-taxonomy] standalone run ${i + 1}/${standaloneRuns}...\n`)
    runs.push(runOnce('standalone'))
  }
  for (let i = 0; i < turboRuns; i++) {
    process.stderr.write(`[test-flake-taxonomy] turbo-co-schedule run ${i + 1}/${turboRuns}...\n`)
    runs.push(runOnce('turbo'))
  }

  const { counts, repro } = aggregateClasses(runs)
  const report = {
    generatedAt: new Date().toISOString(),
    totalRuns: runs.length,
    standaloneRuns,
    turboRuns,
    classCounts: counts,
    reproByClass: repro,
    runs: runs.map((r) => ({ runId: r.runId, mode: r.mode, exitCode: r.exitCode, nonPassFileCount: r.classifiedRecords.length, warnings: r.warnings })),
  }
  console.log(JSON.stringify(report, null, 2))
}

// `import.meta.main` is Node 24+ (this repo's `engines.node`, same guard
// `test-flake-report.mjs` / `migrate.mjs` use) — lets
// `test-flake-taxonomy.test.mjs` import the pure helpers above without
// triggering a real N-run baseline.
if (import.meta.main) {
  main()
}
