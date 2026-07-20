#!/usr/bin/env node
// Pure helpers shared by the flake-report producer/consumer redesign
// (feature-flake-report-detection-redesign): `scripts/test-flake-report.mjs`
// (the local, opt-in full-suite dev tool), `scripts/test-flake-report-produce.mjs`
// (CI `test` job: writes the manifest a downstream job can trust) and
// `scripts/test-flake-report-consume.mjs` (CI `flake-report` job: reads the
// manifest, solo-reruns only what @crowi/api jest itself did not pass, and
// classifies FLAKY / REGRESSION / INCONCLUSIVE). All three live in the SAME
// module system (plain Node ESM at the repo root) so, unlike the
// `packages/api` ⇔ `scripts/` boundary (ts-jest/CJS vs plain ESM — see
// `db-connect-retry.ts` / `test-flake-report.mjs`'s "near-miss" section for
// why THAT boundary is deliberately duplicated instead of shared), there is
// no reason to duplicate this logic three times — it is imported instead.
//
// ── run-scoped path formulas ──
//
// Every path below is keyed by `CROWI_TEST_RUN_ID` (AC-1: the CI `test` job
// sets it — `${{ github.run_id }}-${{ github.run_attempt }}` — BEFORE
// `pnpm test`, and `turbo.json`'s `globalPassThroughEnv` forwards it into the
// api jest child, so `global-setup.js`'s `CROWI_TEST_RUN_ID ??= ...` adopts
// the CI value instead of self-generating one). Both the `test` job (producer)
// and the `flake-report` job (consumer) can independently recompute the exact
// same id from `github.run_id`/`github.run_attempt` — the SAME context values
// in every job of one workflow run — which is what lets the consumer verify
// the manifest's `runId` without any extra cross-job handoff (AC-2's "manifest
// の run-ID を検証してから読む").
import { tmpdir } from 'node:os'
import path from 'node:path'

export function generateRunId() {
  return `${process.pid}-${Date.now().toString(36)}`
}

/**
 * Independent duplicate of `packages/api/src/test/db-connect-retry.ts`'s
 * `resolveRetryEventsPath()` path formula (kept here, not there — this file
 * is imported by three ESM scripts; that one is ts-jest/CJS inside a
 * different package with no shared module boundary, same reasoning as the
 * pre-existing near-miss duplication `test-flake-report.mjs` already
 * documents). Keep the two in sync if either changes.
 */
export function resolveNearMissEventsPath(runId) {
  return path.join(tmpdir(), `crowi-api-test-retry-events.${runId}.jsonl`)
}

/** Deterministic location for @crowi/api jest's `--outputFile` (AC-1/AC-2: CI-limited `--json` output, env-gated via `packages/api/package.json`'s `test` script). */
export function resolveApiJestOutputPath(runId) {
  return path.join(tmpdir(), `crowi-api-test-result.${runId}.json`)
}

/** Where the producer (`test` job) writes the manifest the consumer (`flake-report` job) downloads and verifies (AC-2). */
export function resolveManifestPath(runId) {
  return path.join(tmpdir(), `crowi-flake-report-manifest.${runId}.json`)
}

/** Where the consumer writes its own classification report, uploaded as a second artifact (AC-6: "summary + artifact に必ず出す"). */
export function resolveClassificationReportPath(runId) {
  return path.join(tmpdir(), `crowi-flake-report-classification.${runId}.json`)
}

// ── jest `--json --outputFile` parsing (unchanged from the pre-redesign script) ──

/**
 * Given a parsed jest `--json --outputFile` document, returns `{ file,
 * status, message }` for every test file whose `status !== 'passed'` —
 * `failed` under a normal run, but also covers jest's `focused` / `skipped`
 * statuses so this never silently ignores a non-nominal outcome (see
 * `formatTestResults.js`'s 4 possible values). Pure — takes the
 * already-parsed JSON, no file I/O.
 */
export function selectNonPassedTestFiles(jestJsonResult) {
  const testResults = jestJsonResult && Array.isArray(jestJsonResult.testResults) ? jestJsonResult.testResults : []
  return testResults
    .filter((result) => result.status !== 'passed')
    .map((result) => ({ file: result.name, status: result.status, message: result.message ?? '' }))
}

// ── near-miss JSON-Lines side channel (unchanged from the pre-redesign script) ──

/**
 * Parses a near-miss JSON-Lines side channel's raw content into `{ events,
 * warnings }`. Blank lines are skipped silently; a line that isn't valid
 * JSON is skipped but reported back as a warning string rather than
 * throwing — a single corrupt row must not take down the whole report.
 */
export function parseNearMissJsonl(content) {
  const events = []
  const warnings = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch (err) {
      warnings.push(`could not parse a near-miss JSONL line as JSON (${err.message}): ${line}`)
    }
  }
  return { events, warnings }
}

/** Groups near-miss events by `testFilePath` so a report can attach them to the file they occurred in. */
export function groupNearMissByFile(events) {
  const byFile = new Map()
  for (const event of events) {
    const key = event && typeof event.testFilePath === 'string' ? event.testFilePath : '(unknown file)'
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push(event)
  }
  return [...byFile.entries()].map(([testFilePath, fileEvents]) => ({
    testFilePath,
    count: fileEvents.length,
    events: fileEvents,
  }))
}

// ── solo-rerun classification (AC-4: FLAKY / REGRESSION / INCONCLUSIVE) ──

// Same two `jest-worker@29.7.0` `ChildProcessWorker._onExit` message shapes
// `packages/api/src/test/failure-taxonomy-reporter.js`'s `classifyExecError`
// matches — duplicated here (different module system, see this file's top
// comment) because a solo rerun is a plain `spawnSync` of the `pnpm --filter
// @crowi/api test` CLI, not a jest run this process can attach a reporter
// to: the only evidence available is the captured stdout/stderr text, so a
// worker crash that jest itself recovered from (exiting 1 with a normal
// failing-test report) needs to be recognized from that text, not just from
// `spawnSync`'s own `status`/`signal`.
const WORKER_TERMINATED_PATTERN = /terminated by another process: signal=(\w+), exitCode=(-?\d+|null)/
const WORKER_CRASHED_PATTERN = /crashed for an unknown reason: exitCode=(-?\d+|null)/
const WORKER_OOM_PATTERN = /ran out of memory and crashed/
// `db-connect-retry.ts`'s `CONNECT_ERROR_MESSAGE_PREFIX` — a solo rerun that
// cannot even connect to the test Mongo is an infrastructure failure, not a
// product regression.
const DB_CONNECT_FAILURE_PATTERN = /Cannot connect to Database Server:/
// `global-teardown.js`'s `checkRedisSmokeCategoryCoverage()`: CI-only
// (`process.env.CI === 'true'`, which every solo rerun sets) and asserts
// all 8 Redis smoke categories' `beforeAll` markers ran — an invariant only
// the FULL suite can satisfy. A solo rerun of any single file that isn't
// one of those 8 smoke-suite files itself will ALWAYS trip this and exit
// non-zero, regardless of whether the file under investigation passed —
// confirmed empirically: `CI=true pnpm --filter @crowi/api test
// --runTestsByPath <any non-smoke file>` exits 1 via this exact
// globalTeardown rejection even when every test in that file passes. Left
// unmatched, this silently turned the classifier into an always-REGRESSION
// machine for solo reruns of anything outside those 8 files.
const REDIS_SMOKE_COVERAGE_PATTERN = /Redis smoke categories missing in CI/

/**
 * Scans a solo rerun's captured stderr for known infrastructure-failure
 * signatures. Returns a human-readable reason string, or `null` when no
 * known signature matched (the caller then treats a non-zero exit as a real
 * REGRESSION, not INCONCLUSIVE — this function must never invent a false
 * positive, since that would hide a genuine product bug).
 */
export function matchInfrastructureStderr(stderr) {
  if (typeof stderr !== 'string' || !stderr) return null
  if (WORKER_TERMINATED_PATTERN.test(stderr)) return 'a jest worker was terminated by a signal during the solo rerun (see captured stderr)'
  if (WORKER_CRASHED_PATTERN.test(stderr)) return 'a jest worker crashed for an unknown reason during the solo rerun (see captured stderr)'
  if (WORKER_OOM_PATTERN.test(stderr)) return 'a jest worker ran out of memory during the solo rerun (see captured stderr)'
  if (DB_CONNECT_FAILURE_PATTERN.test(stderr)) return 'the solo rerun could not connect to the test database (see captured stderr)'
  if (REDIS_SMOKE_COVERAGE_PATTERN.test(stderr))
    return "the solo rerun's globalTeardown rejected for missing full-suite-only Redis smoke category coverage — expected for any single-file solo rerun, not a reflection of this file (see captured stderr)"
  return null
}

/**
 * Classifies ONE solo-rerun outcome (AC-4's 3-state model, superseding the
 * pre-redesign 2-state `classifyRerunExitCode`):
 *   - `error` (spawn itself failed to launch, e.g. a missing binary) → INCONCLUSIVE
 *   - `signal` (the process was killed by a signal, e.g. SIGSEGV) → INCONCLUSIVE
 *   - `status` is `null`/`undefined` (spawnSync's own "neither exit code nor
 *     signal observed" state) → INCONCLUSIVE
 *   - `status === 0` → FLAKY (passed standalone; only failed under load)
 *   - `status !== 0` and stderr matches a known infrastructure signature
 *     (worker crash / DB connect failure) → INCONCLUSIVE
 *   - otherwise → REGRESSION (fails standalone too — a real break)
 */
export function classifyRerunOutcome({ status, signal, error, stderr }) {
  if (error) {
    // `spawnSync(..., { timeout })` sets BOTH `error.code === 'ETIMEDOUT'` AND
    // `signal` (the kill signal, `SIGTERM` by default) when the timeout —
    // not a launch failure — is what stopped the process; call that out by
    // name instead of the generic "failed to launch" wording below, which
    // would otherwise mislead whoever reads this in the classification
    // artifact into thinking pnpm/jest itself never started.
    if (error.code === 'ETIMEDOUT') {
      return { classification: 'INCONCLUSIVE', reason: `solo rerun exceeded its timeout and was killed: ${error.message}` }
    }
    return { classification: 'INCONCLUSIVE', reason: `failed to launch the solo rerun: ${error.message}` }
  }
  if (signal) {
    return { classification: 'INCONCLUSIVE', reason: `solo rerun was terminated by signal ${signal}` }
  }
  if (status === null || status === undefined) {
    return { classification: 'INCONCLUSIVE', reason: 'solo rerun exited with no exit code and no signal (spawnSync null status)' }
  }
  if (status === 0) {
    return { classification: 'FLAKY', reason: null }
  }
  const infraReason = matchInfrastructureStderr(stderr)
  if (infraReason) {
    return { classification: 'INCONCLUSIVE', reason: infraReason }
  }
  return { classification: 'REGRESSION', reason: null }
}

/**
 * Emits a GitHub Actions workflow-command annotation (`::error::` for
 * REGRESSION, `::warning::` for FLAKY / INCONCLUSIVE) for one classified
 * solo-rerun — harmless no-ops outside CI, but the "identifiable via
 * annotation or log" surface both `test-flake-report.mjs` (local) and
 * `test-flake-report-consume.mjs` (CI) rely on. `regressionContext` /
 * `flakyContext` let each caller phrase "not just under load" for its own
 * run shape (full-suite vs. the `test` job's run) without duplicating the
 * three-way branch itself.
 */
export function annotateClassification(classification, file, reason, { regressionContext, flakyContext }) {
  if (classification === 'REGRESSION') {
    console.log(`::error file=${file}::REGRESSION — ${file} fails standalone too, not just ${regressionContext}`)
  } else if (classification === 'INCONCLUSIVE') {
    console.log(`::warning file=${file}::INCONCLUSIVE — ${reason}`)
  } else {
    console.log(`::warning file=${file}::FLAKY — ${file} ${flakyContext} but passed standalone`)
  }
}

// ── manifest (AC-2: run-ID + artifact paths the consumer verifies before reading) ──

export const MANIFEST_SCHEMA_VERSION = 1

/**
 * Assembles the manifest the producer (`test` job) writes and the consumer
 * (`flake-report` job) downloads + verifies. `apiJestOutputFileWritten` /
 * `nearMissEventsFileWritten` record whether the producer actually found
 * those files at manifest-build time — the consumer never globs for them
 * (AC-2's explicit "glob 頼みにしない"), it only ever looks for the exact
 * basenames this manifest names, and only when the corresponding `*Written`
 * flag is true.
 */
export function buildManifest({
  runId,
  generatedAt,
  workflowRunId,
  workflowRunAttempt,
  apiJestOutputFile,
  apiJestOutputFileWritten,
  nearMissEventsFile,
  nearMissEventsFileWritten,
}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    generatedAt,
    producer: {
      job: 'test',
      workflowRunId: workflowRunId ?? null,
      workflowRunAttempt: workflowRunAttempt ?? null,
    },
    apiJest: {
      outputFile: apiJestOutputFile,
      outputFileWritten: Boolean(apiJestOutputFileWritten),
    },
    nearMiss: {
      eventsFile: nearMissEventsFile,
      eventsFileWritten: Boolean(nearMissEventsFileWritten),
    },
  }
}

/**
 * Parses raw manifest JSON, rejecting anything that isn't a recognizable,
 * schema-matching manifest object instead of throwing — a single malformed
 * manifest must surface as `source unavailable / out-of-scope` (AC-5), not
 * crash the non-blocking consumer job.
 */
export function parseManifestJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { manifest: null, error: 'manifest content is empty' }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (err) {
    return { manifest: null, error: `manifest is not valid JSON: ${err.message}` }
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.runId !== 'string') {
    return { manifest: null, error: 'manifest JSON is not a recognizable manifest object (missing a string runId)' }
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      manifest: null,
      error: `manifest schemaVersion ${JSON.stringify(manifest.schemaVersion)} is not the version this consumer understands (${MANIFEST_SCHEMA_VERSION})`,
    }
  }
  return { manifest, error: null }
}

/**
 * `true` iff `manifest.runId` matches `expectedRunId` — the consumer's own
 * independently-computed `${{ github.run_id }}-${{ github.run_attempt }}`
 * (AC-2's "manifest の run-ID を検証してから読む"). A mismatch means the
 * downloaded artifact does not belong to this workflow run (should be
 * structurally impossible given the run-scoped artifact name, but rejected
 * defensively rather than trusted blindly — same posture as
 * `failure-taxonomy-channel.js`'s `readChannel`).
 */
export function verifyManifestRunId(manifest, expectedRunId) {
  if (!manifest || manifest.runId !== expectedRunId) {
    return {
      ok: false,
      reason: `manifest runId ${JSON.stringify(manifest && manifest.runId)} does not match this workflow run's expected id ${JSON.stringify(expectedRunId)}`,
    }
  }
  return { ok: true, reason: null }
}

/**
 * A matching `runId` alone is NOT the full run-ID/path correlation contract
 * (AC-2's manifest verification): a manifest could carry the right `runId`
 * while its `apiJest.outputFile` / `nearMiss.eventsFile` fields point at
 * SOME OTHER file — the consumer only ever reads `path.basename(...)` of
 * those fields against the downloaded artifact directory, so an unverified
 * path would let a same-run manifest select an unrelated artifact file. This
 * checks both fields against the SAME deterministic path formulas the
 * producer used to build them (`resolveApiJestOutputPath` /
 * `resolveNearMissEventsPath`) — the manifest's own claim is trusted only
 * once it is shown to equal what this run's id independently recomputes.
 */
export function verifyManifestPaths(manifest, runId) {
  const expectedApiJestPath = resolveApiJestOutputPath(runId)
  const actualApiJestPath = manifest?.apiJest?.outputFile
  if (actualApiJestPath !== expectedApiJestPath) {
    return {
      ok: false,
      reason: `manifest apiJest.outputFile ${JSON.stringify(actualApiJestPath)} does not match the deterministic path for run ${JSON.stringify(runId)} (${JSON.stringify(expectedApiJestPath)})`,
    }
  }
  const expectedNearMissPath = resolveNearMissEventsPath(runId)
  const actualNearMissPath = manifest?.nearMiss?.eventsFile
  if (actualNearMissPath !== expectedNearMissPath) {
    return {
      ok: false,
      reason: `manifest nearMiss.eventsFile ${JSON.stringify(actualNearMissPath)} does not match the deterministic path for run ${JSON.stringify(runId)} (${JSON.stringify(expectedNearMissPath)})`,
    }
  }
  return { ok: true, reason: null }
}

// ── artifact-size guard for raw diagnostics (AC-4: offline stderr/exit/signal
// preservation for infrastructure/inconclusive reruns) ──

// Same shape as `failure-taxonomy-reporter.js`'s `EXCERPT_MAX_LENGTH` (2000)
// but generous enough to keep a full jest failure report (stack traces +
// diffs), not just one assertion's message — a solo rerun's stderr is the
// ONLY raw diagnostic evidence available for classification, so this must
// stay large; it only exists to bound worst-case artifact size, not to
// aggressively trim.
const STDERR_EXCERPT_MAX_LENGTH = 20_000

/** Caps a captured stderr/stdout string for inclusion in the classification artifact; `null`/non-string input passes through as `null`. */
export function truncateForArtifact(text, maxLength = STDERR_EXCERPT_MAX_LENGTH) {
  if (typeof text !== 'string' || text.length === 0) return null
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}… (truncated, ${text.length} bytes total)`
}
