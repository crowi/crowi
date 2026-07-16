#!/usr/bin/env node
// CI `flake-report` job (feature-flake-report-detection-redesign): downloads
// the `test` job's producer artifact, verifies the manifest's run id,
// solo-reruns only the `@crowi/api` jest files that run itself did NOT pass,
// and classifies each as FLAKY / REGRESSION / INCONCLUSIVE (AC-2/AC-4).
// Never reports green when the evidence is missing, foreign, or out of
// `@crowi/api`'s scope (AC-5) — see `decideProvenance` / `classifyApiJestEvidence`
// below for the exact decision tree. Writes both `$GITHUB_STEP_SUMMARY` and a
// JSON report artifact (AC-6), and never gates `test`'s own red/green — this
// job is `continue-on-error: true` end to end (`.github/workflows/ci.yml`).
//
// Pure decision-tree functions are exported and unit-tested in
// `test-flake-report-consume.test.mjs`; `main()` (artifact I/O + spawning
// real solo reruns) is glue, same untested-`main()` precedent as
// `test-flake-report.mjs` / `migrate.mjs`.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  annotateClassification,
  classifyRerunOutcome,
  generateRunId,
  groupNearMissByFile,
  parseManifestJson,
  parseNearMissJsonl,
  resolveClassificationReportPath,
  selectNonPassedTestFiles,
  truncateForArtifact,
  verifyManifestPaths,
  verifyManifestRunId,
} from './flake-report-shared.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const EMPTY_COUNTS = { FLAKY: 0, REGRESSION: 0, INCONCLUSIVE: 0 }
const PRODUCER_SCOPE = '@crowi/api jest only'
// A solo rerun is ONE test file, so a hung process is a genuine anomaly, not
// a slow-but-normal suite — bounded generously (a full `@crowi/api` run
// itself takes low-single-digit minutes) so this only ever fires for a
// process that would otherwise hang until GitHub's own job-level timeout
// kills the whole (non-blocking) job and silently drops the summary/artifact
// this script exists to emit (AC-4/AC-6). Enforced by `soloRerunApiFile`'s
// OWN `setTimeout` watchdog, not `child_process.spawn`'s built-in `timeout`
// option — see that function's doc comment for why.
const SOLO_RERUN_TIMEOUT_MS = 5 * 60 * 1000

// ── decision tree (pure, unit-tested) ──

/**
 * First gate, BEFORE any manifest/artifact content is even looked at
 * (AC-5's "cancel" / "artifact 欠落" cases — neither may ever be reported as
 * green):
 *   - the `test` job was cancelled or skipped → `cancelled`.
 *   - the artifact could not be downloaded at all (the download step itself
 *     failed, or the expected manifest file simply isn't present after a
 *     successful download) → `source-unavailable`.
 *   - otherwise → `proceed` (safe to read the manifest).
 */
export function decideProvenance({ testJobResult, artifactAvailable }) {
  if (testJobResult === 'cancelled') {
    return { status: 'cancelled', reason: `the "test" job was cancelled (result: ${testJobResult}) — no @crowi/api result to classify` }
  }
  if (testJobResult === 'skipped') {
    return { status: 'cancelled', reason: `the "test" job was skipped (result: ${testJobResult}) — no @crowi/api result to classify` }
  }
  if (!artifactAvailable) {
    return { status: 'source-unavailable', reason: 'the flake-report artifact from the "test" job could not be downloaded (missing, or the download step itself failed)' }
  }
  return { status: 'proceed', reason: null }
}

/**
 * Parses raw jest `--json --outputFile` content without throwing — mirrors
 * `parseManifestJson`'s `{ <value>, error }` shape. Valid-but-wrong-shaped
 * JSON (e.g. `{}`, or `testResults` missing/not an array — a truncated
 * write, a different tool's JSON, a jest major-version format change) is
 * ALSO rejected here, not just outright parse failures: `selectNonPassedTestFiles`
 * treats a missing `testResults` as "zero non-passed files" by design (a
 * malformed shape must never fall through the same path and get
 * misclassified as "@crowi/api suite is clean" — that would hide a failed
 * `test` job behind `non-api-failure` instead of surfacing the real
 * INCONCLUSIVE json-corruption state, AC-4).
 *
 * The SAME reasoning applies one level deeper, per-entry: a `testResults`
 * array that itself contains a `null`/non-object item, or an item missing a
 * string `name`/`status` (e.g. `{ "testResults": [null] }` — a partial write
 * torn mid-array, or a future jest format change), must not reach
 * `selectNonPassedTestFiles` unchecked. That function does `result.status`
 * on every entry — a `null` entry would throw a raw `TypeError` out of this
 * otherwise-defensive, non-blocking consumer job instead of degrading to the
 * documented `inconclusive-no-evidence` path, silently DROPPING the summary
 * + artifact this whole script exists to always emit (AC-5/AC-6). So every
 * entry is shape-checked HERE, before `json` is ever handed back as "usable".
 */
export function parseJestJson(raw) {
  let json
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { json: null, error: `@crowi/api jest's --json output could not be parsed: ${err.message}` }
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.testResults)) {
    return { json: null, error: "@crowi/api jest's --json output is valid JSON but not a recognizable jest result (missing a testResults array)" }
  }
  const malformedIndex = json.testResults.findIndex(
    (result) => !result || typeof result !== 'object' || typeof result.name !== 'string' || typeof result.status !== 'string',
  )
  if (malformedIndex !== -1) {
    return {
      json: null,
      error: `@crowi/api jest's --json output's testResults[${malformedIndex}] is not a recognizable per-file result (each entry needs a string name and a string status)`,
    }
  }
  return { json, error: null }
}

/**
 * Reads the downloaded manifest and verifies BOTH its `runId` (AC-2's
 * "manifest の run-ID を検証してから読む") AND that its `apiJest.outputFile`
 * / `nearMiss.eventsFile` fields equal the SAME run's deterministic path
 * formulas — a matching `runId` alone does not prove the paths inside the
 * manifest are the ones this run actually produced (see
 * `verifyManifestPaths`'s doc comment in `flake-report-shared.mjs`).
 * `manifestRaw === null` means the manifest file itself was not found in the
 * downloaded artifact.
 */
export function verifyManifest({ manifestRaw, expectedRunId }) {
  const { manifest, error } = parseManifestJson(manifestRaw ?? '')
  if (error) {
    return { ok: false, manifest: null, reason: `manifest could not be read: ${error}` }
  }
  const verifiedRunId = verifyManifestRunId(manifest, expectedRunId)
  if (!verifiedRunId.ok) {
    return { ok: false, manifest, reason: verifiedRunId.reason }
  }
  const verifiedPaths = verifyManifestPaths(manifest, expectedRunId)
  if (!verifiedPaths.ok) {
    return { ok: false, manifest, reason: verifiedPaths.reason }
  }
  return { ok: true, manifest, reason: null }
}

/**
 * Given a VERIFIED manifest and the already-attempted jest-json parse
 * result, decides between three outcomes (AC-4/AC-5):
 *   - `inconclusive-no-evidence`: the producer never wrote `@crowi/api`
 *     jest's `--json` output (crashed before completing) OR that output
 *     could not be parsed (missing from the artifact / corrupted). Neither
 *     is a product REGRESSION — there is simply no evidence to classify.
 *   - `non-api-failure`: the api suite itself reported ZERO non-pass files,
 *     but the `test` job still failed overall — a DIFFERENT step/package
 *     (web/collab/build/`test:scripts`) is why, which is out of this
 *     report's `@crowi/api`-only scope (never shown as green).
 *   - `classified`: a real (possibly empty, on a genuinely green run)
 *     `nonPassed` list to solo-rerun.
 */
export function classifyApiJestEvidence({ manifest, jestJsonParseResult, testJobResult }) {
  if (!manifest.apiJest.outputFileWritten) {
    return {
      status: 'inconclusive-no-evidence',
      reason: '@crowi/api jest never wrote its --json output for this run (it crashed before completing, e.g. a globalSetup failure)',
      nonPassed: [],
    }
  }
  if (jestJsonParseResult.error) {
    return { status: 'inconclusive-no-evidence', reason: jestJsonParseResult.error, nonPassed: [] }
  }
  const nonPassed = selectNonPassedTestFiles(jestJsonParseResult.json)
  if (nonPassed.length === 0 && testJobResult === 'failure') {
    return {
      status: 'non-api-failure',
      reason: 'the "test" job failed but @crowi/api jest itself reported zero non-pass files — a different step/package failed (web/collab/build/test:scripts)',
      nonPassed: [],
    }
  }
  return { status: 'classified', reason: null, nonPassed }
}

/** Tallies a classified files list into `{ FLAKY, REGRESSION, INCONCLUSIVE }` counts. */
export function summarizeClassifications(files) {
  const counts = { ...EMPTY_COUNTS }
  for (const file of files) counts[file.classification] += 1
  return counts
}

/**
 * Decides the near-miss evidence's OWN provenance, distinct from the overall
 * report `status` above (AC-3/AC-5): a report must be able to tell "the
 * producer's near-miss channel recorded zero events because no connect
 * retry fired" (`not-fired` — a normal, complete-evidence green case) apart
 * from "the manifest says a near-miss file WAS written, but it is not in
 * the downloaded artifact" (`unavailable` — a missing-evidence case that
 * must not be silently rendered the same as `not-fired`, which is exactly
 * what an unconditional `nearMissRaw === null → []` fallback did before this
 * function existed).
 */
export function resolveNearMissEvidence({ manifest, nearMissRaw }) {
  if (!manifest.nearMiss.eventsFileWritten) {
    return { status: 'not-fired', nearMiss: [], warnings: [] }
  }
  if (nearMissRaw === null) {
    return {
      status: 'unavailable',
      nearMiss: [],
      warnings: [],
      reason: 'the manifest recorded a near-miss JSONL as written for this run, but it was not present in the downloaded artifact',
    }
  }
  const { events, warnings } = parseNearMissJsonl(nearMissRaw)
  return { status: 'available', nearMiss: groupNearMissByFile(events), warnings }
}

/**
 * Renders the `$GITHUB_STEP_SUMMARY` markdown for one report (AC-6: FLAKY /
 * REGRESSION / INCONCLUSIVE distinguished, `@crowi/api`-only scope stated up
 * front, non-green states for `cancelled` / `source-unavailable` /
 * `non-api-failure` / `inconclusive-no-evidence` are never rendered as "no
 * flakes found").
 */
export function buildStepSummaryMarkdown({ runId, testJobResult, status, reason, counts, files, nearMiss, nearMissStatus = 'not-fired' }) {
  const lines = [`## flake-report (producer scope: ${PRODUCER_SCOPE})`, '', `Run \`${runId}\` — \`test\` job result: \`${testJobResult}\``, '']

  if (status === 'cancelled') {
    lines.push(`**cancelled** — ${reason}`)
    // A cancellation mid solo-rerun (main()'s own SIGTERM/SIGINT handling,
    // distinct from the upstream `test` job's cancellation `decideProvenance`
    // already covers) can still carry partial, already-classified files —
    // surface them instead of discarding real evidence just because the run
    // as a whole was cut short.
    if (files.length > 0) {
      lines.push('')
      lines.push(`Partial classification before cancellation — FLAKY: ${counts.FLAKY} · REGRESSION: ${counts.REGRESSION} · INCONCLUSIVE: ${counts.INCONCLUSIVE}`)
      lines.push('')
      lines.push('| file | classification | reason |')
      lines.push('| --- | --- | --- |')
      for (const file of files) lines.push(`| \`${file.file}\` | ${file.classification} | ${file.reason ?? '—'} |`)
    }
    return lines.join('\n')
  }
  if (status === 'source-unavailable') {
    lines.push(`**source unavailable** — ${reason}`)
    lines.push('')
    lines.push('_Not shown as green: this is a missing-evidence state, not "no flakes found"._')
    return lines.join('\n')
  }
  if (status === 'non-api-failure') {
    lines.push(`**out of scope (non-API failure)** — ${reason}`)
    lines.push('')
    lines.push('_Not shown as green: `test` failed for a reason outside this report\'s @crowi/api-only scope._')
    return lines.join('\n')
  }
  if (status === 'inconclusive-no-evidence') {
    lines.push(`**INCONCLUSIVE** — ${reason}`)
    return lines.join('\n')
  }

  // status === 'classified'
  lines.push(`FLAKY: ${counts.FLAKY} · REGRESSION: ${counts.REGRESSION} · INCONCLUSIVE: ${counts.INCONCLUSIVE}`)
  lines.push('')
  if (files.length === 0) {
    lines.push('No non-pass @crowi/api jest files in this run.')
  } else {
    lines.push('| file | classification | reason |')
    lines.push('| --- | --- | --- |')
    for (const file of files) {
      lines.push(`| \`${file.file}\` | ${file.classification} | ${file.reason ?? '—'} |`)
    }
  }
  if (nearMissStatus === 'unavailable') {
    lines.push('')
    lines.push('### near-miss data unavailable')
    lines.push('')
    lines.push(
      '_The manifest recorded a near-miss JSONL as written for this run, but it was not present in the downloaded artifact — this is NOT "no retries fired", the evidence is simply missing._',
    )
  } else if (nearMiss.length > 0) {
    lines.push('')
    lines.push('### near-miss (a DB connect retry fired, but the file still went green)')
    lines.push('')
    lines.push('| file | retry count |')
    lines.push('| --- | --- |')
    for (const entry of nearMiss) lines.push(`| \`${entry.testFilePath}\` | ${entry.count} |`)
  }
  return lines.join('\n')
}

// ── glue (artifact I/O + real solo-rerun child processes — not covered by
// the unit tests, same precedent as test-flake-report.mjs's untested main()) ──

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
}

/**
 * Runs ONE solo rerun asynchronously (`child_process.spawn`, not
 * `spawnSync`) and resolves once it exits — same captured-stdout/stderr
 * shape `spawnSync` used to return (`{ status, signal, error, stdout,
 * stderr }`) so `classifyRerunOutcome` is unchanged, but async on purpose:
 * `spawnSync` blocks the WHOLE event loop for the rerun's entire duration,
 * including Node's own signal delivery (a `process.on('SIGTERM', ...)`
 * handler cannot run until a blocking `spawnSync` call returns — libuv
 * routes signal callbacks through the very event loop `spawnSync` starves).
 * `main()`'s cancellation handling below relies on the event loop staying
 * live DURING a rerun, which only an async `spawn` allows.
 *
 * `onStart(child)` hands the live `ChildProcess` back to the caller so it
 * can be `.kill()`ed from a signal handler while in flight.
 *
 * The timeout is a hand-rolled `setTimeout` watchdog, not
 * `child_process.spawn`'s own `timeout` option: that option only KILLS the
 * child on expiry, it does not raise Node's `error` event the way
 * `spawnSync`'s `timeout` used to (verified empirically — the async
 * `spawn({ timeout })` path only ever emits `close(null, 'SIGTERM')`, never
 * `error`), which would collapse this function's `ETIMEDOUT`-specific
 * classification into the same generic "terminated by signal SIGTERM"
 * reason a plain external kill (e.g. `main()`'s OWN cancellation kill,
 * below) produces — losing the "this hung, not just got cancelled"
 * distinction the previous review round asked for. The watchdog instead
 * synthesizes the SAME `{ code: 'ETIMEDOUT' }` error shape `spawnSync` used
 * to produce, so `classifyRerunOutcome`'s existing contract is untouched.
 */
function soloRerunApiFile(file, env, onStart) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['--filter', '@crowi/api', 'test', '--runTestsByPath', file], { cwd: repoRoot, env })
    onStart?.(child)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, SOLO_RERUN_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(watchdog)
      resolve({ status: null, signal: null, error, stdout, stderr })
    })
    child.once('close', (status, signal) => {
      clearTimeout(watchdog)
      if (timedOut) {
        const timeoutError = new Error(`solo rerun exceeded its ${SOLO_RERUN_TIMEOUT_MS}ms timeout and was killed`)
        timeoutError.code = 'ETIMEDOUT'
        resolve({ status, signal, error: timeoutError, stdout, stderr })
        return
      }
      resolve({ status, signal, error: null, stdout, stderr })
    })
  })
}

function writeReport({ runId, testJobResult, status, reason, counts, files, nearMiss, nearMissStatus = 'not-fired' }) {
  const report = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    testJobResult,
    producerScope: PRODUCER_SCOPE,
    status,
    reason,
    counts,
    files,
    nearMiss,
    nearMissStatus,
  }

  const summaryMd = buildStepSummaryMarkdown({ runId, testJobResult, status, reason, counts, files, nearMiss, nearMissStatus })
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMd}\n`)
  } else {
    process.stdout.write(`${summaryMd}\n`)
  }

  if (runId) {
    try {
      writeFileSync(resolveClassificationReportPath(runId), JSON.stringify(report, null, 2))
    } catch (err) {
      process.stderr.write(`[flake-report-consume] failed to write the classification report artifact: ${err.message}\n`)
    }
  }

  console.log(JSON.stringify(report, null, 2))

  const hasRegression = files.some((file) => file.classification === 'REGRESSION')
  process.exitCode = hasRegression ? 1 : 0
}

async function main() {
  const runId = process.env.CROWI_TEST_RUN_ID
  const testJobResult = process.env.CROWI_FLAKE_REPORT_TEST_JOB_RESULT ?? 'unknown'
  const artifactDir = process.env.CROWI_FLAKE_REPORT_ARTIFACT_DIR ?? path.join(repoRoot, '.flake-report-artifact')
  const downloadOutcome = process.env.CROWI_FLAKE_REPORT_ARTIFACT_DOWNLOAD_OUTCOME ?? 'unknown'

  if (!runId || !runId.trim()) {
    writeReport({ runId: '(unknown)', testJobResult, status: 'source-unavailable', reason: 'CROWI_TEST_RUN_ID is unset for this consumer job', counts: EMPTY_COUNTS, files: [], nearMiss: [] })
    return
  }

  const manifestBasename = `crowi-flake-report-manifest.${runId}.json`
  const artifactAvailable = downloadOutcome === 'success' && existsSync(path.join(artifactDir, manifestBasename))

  const provenance = decideProvenance({ testJobResult, artifactAvailable })
  if (provenance.status !== 'proceed') {
    writeReport({ runId, testJobResult, status: provenance.status, reason: provenance.reason, counts: EMPTY_COUNTS, files: [], nearMiss: [] })
    return
  }

  const manifestRaw = readIfExists(path.join(artifactDir, manifestBasename))
  const verified = verifyManifest({ manifestRaw, expectedRunId: runId })
  if (!verified.ok) {
    writeReport({ runId, testJobResult, status: 'source-unavailable', reason: verified.reason, counts: EMPTY_COUNTS, files: [], nearMiss: [] })
    return
  }

  const { manifest } = verified
  const jestJsonRaw = manifest.apiJest.outputFileWritten ? readIfExists(path.join(artifactDir, path.basename(manifest.apiJest.outputFile))) : null
  const jestJsonParseResult =
    jestJsonRaw !== null ? parseJestJson(jestJsonRaw) : { json: null, error: '@crowi/api jest --json output file was not present in the downloaded artifact' }

  const evidence = classifyApiJestEvidence({ manifest, jestJsonParseResult, testJobResult })
  if (evidence.status !== 'classified') {
    writeReport({ runId, testJobResult, status: evidence.status, reason: evidence.reason, counts: EMPTY_COUNTS, files: [], nearMiss: [] })
    return
  }

  const nearMissRaw = manifest.nearMiss.eventsFileWritten ? readIfExists(path.join(artifactDir, path.basename(manifest.nearMiss.eventsFile))) : null
  const nearMissEvidence = resolveNearMissEvidence({ manifest, nearMissRaw })
  for (const warning of nearMissEvidence.warnings) process.stderr.write(`[flake-report-consume] ${warning}\n`)
  if (nearMissEvidence.reason) process.stderr.write(`[flake-report-consume] ${nearMissEvidence.reason}\n`)
  const nearMiss = nearMissEvidence.nearMiss

  // Cancellation (AC-5's "cancel" case, but for THIS job, not the upstream
  // `test` job `decideProvenance` already covers above): the solo-rerun loop
  // below is the single biggest window this process spends its wall-clock
  // time in (each rerun can take up to `SOLO_RERUN_TIMEOUT_MS`, and there
  // can be several). If GitHub cancels the `flake-report` job mid-loop, the
  // runner delivers SIGTERM/SIGINT to this process; without a handler, the
  // default disposition is immediate termination — no summary, no artifact,
  // exactly the "no cancelled/source-unavailable report" gap a solo-rerun
  // cancellation must not produce. The handler kills the in-flight child
  // (so it doesn't outlive this process) and stops starting NEW reruns, but
  // still runs `writeReport` with whatever was classified so far, under
  // `status: 'cancelled'` — never silently green. Listeners are removed
  // right after the loop (`finally`) so they don't keep the event loop
  // alive once this function is done with them.
  const files = []
  let cancelledDuringRerun = false
  let activeChild = null
  const onCancelSignal = (signal) => {
    if (cancelledDuringRerun) return
    cancelledDuringRerun = true
    process.stderr.write(`[flake-report-consume] received ${signal} — this job was cancelled mid solo-rerun; reporting 'cancelled' with whatever was classified so far\n`)
    activeChild?.kill('SIGTERM')
  }
  process.once('SIGTERM', onCancelSignal)
  process.once('SIGINT', onCancelSignal)

  try {
    for (const entry of evidence.nonPassed) {
      if (cancelledDuringRerun) break
      const rerunRunId = generateRunId()
      process.stderr.write(`[flake-report-consume] solo rerun: ${entry.file} (run id ${rerunRunId})...\n`)
      const rerunRes = await soloRerunApiFile(entry.file, { ...process.env, CROWI_TEST_RUN_ID: rerunRunId }, (child) => {
        activeChild = child
      })
      activeChild = null
      if (rerunRes.stdout) process.stdout.write(rerunRes.stdout)
      if (rerunRes.stderr) process.stderr.write(rerunRes.stderr)
      const { classification, reason } = classifyRerunOutcome({ status: rerunRes.status, signal: rerunRes.signal, error: rerunRes.error, stderr: rerunRes.stderr })
      files.push({
        file: entry.file,
        classification,
        reason,
        fullSuiteStatus: entry.status,
        firstFailureMessage: entry.message,
        rerunExitCode: rerunRes.status ?? null,
        rerunStderr: truncateForArtifact(rerunRes.stderr),
        rerunSignal: rerunRes.signal ?? null,
      })
      annotateClassification(classification, entry.file, reason, { regressionContext: "under the test job's full run", flakyContext: "did not pass in the test job's run" })
    }
  } finally {
    process.removeListener('SIGTERM', onCancelSignal)
    process.removeListener('SIGINT', onCancelSignal)
  }

  if (cancelledDuringRerun) {
    const remaining = evidence.nonPassed.length - files.length
    writeReport({
      runId,
      testJobResult,
      status: 'cancelled',
      reason: `this flake-report job itself was cancelled during solo-rerun classification (${files.length}/${evidence.nonPassed.length} file(s) classified before cancellation, ${remaining} not rerun)`,
      counts: summarizeClassifications(files),
      files,
      nearMiss,
      nearMissStatus: nearMissEvidence.status,
    })
    return
  }

  writeReport({ runId, testJobResult, status: 'classified', reason: null, counts: summarizeClassifications(files), files, nearMiss, nearMissStatus: nearMissEvidence.status })
}

if (import.meta.main) {
  // `main()` is async (the solo-rerun loop `await`s each rerun so its own
  // SIGTERM/SIGINT handler can actually run — see `main()`'s doc comment
  // above the loop), so the old synchronous try/catch becomes a `.catch()`
  // on the returned promise; same fail-open posture as before.
  main().catch((err) => {
    // Fail-open, same posture as the rest of this measurement pipeline —
    // `.github/workflows/ci.yml` also marks this step `continue-on-error`.
    process.stderr.write(`[flake-report-consume] unexpected error, reporting as source-unavailable: ${err.stack ?? err.message}\n`)
    writeReport({
      runId: process.env.CROWI_TEST_RUN_ID ?? '(unknown)',
      testJobResult: process.env.CROWI_FLAKE_REPORT_TEST_JOB_RESULT ?? 'unknown',
      status: 'source-unavailable',
      reason: `unexpected error in the consumer script: ${err.message}`,
      counts: EMPTY_COUNTS,
      files: [],
      nearMiss: [],
    })
  })
}
