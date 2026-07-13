#!/usr/bin/env node
// `pnpm test:flake` — opt-in flake detector for `@crowi/api`'s full jest
// suite (feature-test-parallel-db-flake-hardening, Phase 4 / B2).
//
// Root `pnpm test` is `turbo run test --concurrency=3`: a package-by-package
// dispatch where every workspace's jest is its own independent child process,
// not one process this script could feed a single `--json --outputFile` to.
// So this script spawns `@crowi/api`'s jest DIRECTLY — `pnpm --filter
// @crowi/api test --json --outputFile=<path>` — bypassing turbo entirely.
// `@crowi/collab` / `@crowi/plugin-search-mongo` are deliberately OUT of
// scope (see the spec's "やらないこと" — B2 is `@crowi/api`-only).
//
// NOTE on the shape of that command: no literal `--` separates `test` from
// the extra jest flags. `pnpm --filter <pkg> <script> -- <args>` (WITH an
// explicit `--`) makes pnpm forward that `--` verbatim into the resulting
// script invocation (`env -u DEBUG TZ=UTC jest --maxWorkers=5 -- --json
// ...`) — and jest's OWN argv parser treats `--` as "everything after this
// is a positional testPathPattern, not a flag", silently turning `--json`
// into a (non-matching) file-path pattern instead of the flag it looks like.
// Omitting the separator (`pnpm --filter <pkg> <script> <args>`) lets pnpm
// forward `<args>` as plain flags, which is what jest actually needs — see
// `spawnApiTest()` below for the one place this matters.
//
// Flow: run the full suite once → read jest's `--json --outputFile` result →
// for every test FILE whose `status !== 'passed'`, solo-rerun just that file
// (same `pnpm --filter @crowi/api test --runTestsByPath <file>` shape) →
// a file that passes alone is classified `FLAKY` (something about running
// under full parallel load made it fail, not the code); a file that fails
// alone too is a real `REGRESSION`. This is a fail → solo-rerun CLASSIFIER,
// not a retry: jest's own `retryTimes` (silently re-running a test body
// until it goes green) is deliberately NOT used anywhere in this repo — that
// would hide the very signal this script exists to surface. The bounded
// CONNECT retry in `src/test/db-connect-retry.ts` (Phase 1 / A1) is a
// different, narrower layer: it retries only `beforeAll`'s DB boot step, and
// only for a specific transient-network failure class — this script doesn't
// touch that decision at all, it only reads its output (see "near-miss"
// below).
//
// ── near-miss (a retry happened but the file still went green) ──
//
// jest's `--json --outputFile` is `formatTestResults()`'s output —
// `assertionResults` / `message` / `status` / `summary` per file — and never
// includes a file's captured `console` output (see
// `@jest/test-result@29.7.0`'s `formatTestResults.js`). So a file where A1's
// connect retry fired once but the file ultimately passed leaves ZERO trace
// in that JSON — `console.warn` alone would never reach this report. A1
// therefore ALSO appends one JSON-Lines row per retry to a run-scoped side
// channel file, independent of whether the file's tests end up green:
// `os.tmpdir()/crowi-api-test-retry-events.<CROWI_TEST_RUN_ID>.jsonl` (see
// `db-connect-retry.ts`'s `resolveRetryEventsPath()`). This script
// reconstructs that SAME path formula independently — it does not import
// `db-connect-retry.ts` (a root `.mjs` script can't import a
// `packages/api/src/test/*.ts` module, and `packages/api`'s build output
// doesn't ship test-only files anyway). This mirrors the "protocol-identical
// but deliberately duplicated, no shared module" choice Phase 3 / B1 already
// made for `@crowi/collab` / `@crowi/plugin-search-mongo`'s probe modules —
// see this file's own `resolveNearMissEventsPath()` and keep it in sync with
// `db-connect-retry.ts`'s `resolveRetryEventsPath()` if either changes.
//
// This script sets `CROWI_TEST_RUN_ID` itself (generated fresh, unless the
// caller already set one) in the full-suite child's env BEFORE spawning it —
// `global-setup.js`'s `process.env.CROWI_TEST_RUN_ID ??= ...` self-generation
// exists specifically so an external orchestrator like this one can supply
// the value first (see that file's doc comment). Because the spawn is direct
// (not through turbo), the value reaches the child as a normal inherited env
// var — no `turbo.json` `globalPassThroughEnv` entry is needed (same
// reasoning Phase 1 used to justify NOT adding `CROWI_TEST_RUN_ID` there).
// Each solo rerun gets its OWN freshly generated run id — reusing the
// full-suite's id would let a rerun's own connect retries (if any) pollute
// the ORIGINAL run's near-miss count for a failure that has nothing to do
// with the near-miss signal this report is trying to measure.
//
// ── placement ──
//
// Local: `pnpm test:flake` (this script, registered as a plain non-turbo
// script — no `turbo.json` task). CI: a NON-BLOCKING job (see
// `.github/workflows/ci.yml`) that duplicates the `test` job's
// `services.mongo` + `env` (without them, `crowi-environment.js`'s CI
// fail-fast throws for every file, and the full suite AND every solo rerun
// fail identically — misclassifying every file as `REGRESSION`). NOT wired
// into the pre-push hook (this repeats the ENTIRE suite plus one rerun per
// failure — too slow to gate every push, and its value is trend-watching in
// CI, not blocking a single developer's push).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── pure helpers (covered by test-flake-report.test.mjs) ──

/**
 * Same generation formula as `global-setup.js`'s `CROWI_TEST_RUN_ID ??= ...`
 * self-generation — not imported (see module doc comment), deliberately
 * duplicated. Uniqueness only needs to hold across processes started around
 * the same moment on one machine, which `pid` + a base36 timestamp gives us.
 */
export function generateRunId() {
  return `${process.pid}-${Date.now().toString(36)}`
}

/**
 * Independent duplicate of `db-connect-retry.ts`'s `resolveRetryEventsPath()`
 * path formula — see this module's doc comment for why it isn't imported.
 * Keep the two in sync if either changes.
 */
export function resolveNearMissEventsPath(runId) {
  return path.join(tmpdir(), `crowi-api-test-retry-events.${runId}.jsonl`)
}

/**
 * Given a parsed jest `--json --outputFile` document, returns `{ file,
 * status, message }` for every test file whose `status !== 'passed'` —
 * `failed` under a normal full run, but also covers jest's `focused` /
 * `skipped` statuses so this classifier never silently ignores a
 * non-nominal outcome (see `formatTestResults.js`'s 4 possible values).
 * Pure — takes the already-parsed JSON, no file I/O.
 */
export function selectNonPassedTestFiles(jestJsonResult) {
  const testResults = jestJsonResult && Array.isArray(jestJsonResult.testResults) ? jestJsonResult.testResults : []
  return testResults
    .filter((result) => result.status !== 'passed')
    .map((result) => ({ file: result.name, status: result.status, message: result.message ?? '' }))
}

/**
 * Solo-rerun exit code → classification. `0` means the file passed standalone
 * (it only failed under full-suite parallel load) → `FLAKY`; anything else
 * means it fails on its own too → `REGRESSION` (a real break, not flake).
 */
export function classifyRerunExitCode(exitCode) {
  return exitCode === 0 ? 'FLAKY' : 'REGRESSION'
}

/**
 * Parses a near-miss JSON-Lines side channel's raw content into `{ events,
 * warnings }`. Blank lines are skipped silently (the file is append-only and
 * may end with a trailing newline); a line that isn't valid JSON is skipped
 * but reported back as a warning string rather than throwing — a single
 * corrupt row (e.g. a torn write from an unrelated concurrent run somehow
 * sharing the path, which run-scoping should prevent, but this is cheap
 * insurance) shouldn't take down the whole report.
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

/**
 * Groups near-miss events by `testFilePath` so the report can attach them to
 * the file they occurred in, regardless of whether that file also appears in
 * `failures` (the whole point of "near miss" is the file went on to pass).
 */
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

/** Assembles the final structured report. Pure — no `Date.now()` inside. */
export function buildReport({ runId, generatedAt, fullSuiteOutputFile, totalTestFiles, failures, nearMiss }) {
  return {
    runId,
    generatedAt,
    fullSuite: {
      outputFile: fullSuiteOutputFile,
      totalTestFiles,
      nonPassedCount: failures.length,
    },
    failures,
    nearMiss,
  }
}

// ── glue (spawns real child processes — not covered by the unit tests, same
// precedent as `migrate.mjs`'s untested `main()`) ──

function spawnApiTest(extraArgs, env) {
  // NO literal `--` before `extraArgs`: `pnpm --filter @crowi/api test -- --json`
  // (with an explicit `--`) makes PNPM ITSELF forward that `--` as a literal
  // token into the resulting command (`env -u DEBUG TZ=UTC jest --maxWorkers=5
  // -- --json ...`) — and jest's OWN CLI parser treats a `--` as "everything
  // after this is a positional testPathPattern, not a flag", so `--json`
  // would silently become a (non-matching) file-path pattern instead of the
  // JSON-output flag. Passing `extraArgs` with no separator lets pnpm forward
  // them as plain flags, which is what jest actually needs here.
  return spawnSync('pnpm', ['--filter', '@crowi/api', 'test', ...extraArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  })
}

function main() {
  const runId = process.env.CROWI_TEST_RUN_ID ?? generateRunId()
  const outputFilePath = path.join(tmpdir(), `crowi-api-test-flake-report-suite.${runId}.json`)

  process.stderr.write(`[test-flake] run id: ${runId}\n`)
  process.stderr.write(`[test-flake] running the full @crowi/api suite (this can take a couple minutes)...\n`)

  const fullSuiteRes = spawnApiTest(['--json', `--outputFile=${outputFilePath}`], { ...process.env, CROWI_TEST_RUN_ID: runId })

  if (fullSuiteRes.error) {
    process.stderr.write(`[test-flake] failed to launch the full suite: ${fullSuiteRes.error.message}\n`)
    process.exitCode = 1
    return
  }

  if (!existsSync(outputFilePath)) {
    process.stderr.write(
      `[test-flake] jest never wrote ${outputFilePath} — the run crashed before completing (e.g. a globalSetup ` +
        'failure), so there is nothing to classify per-file. Treat this as a hard failure, not a flake report.\n',
    )
    process.exitCode = 1
    return
  }

  const jestJson = JSON.parse(readFileSync(outputFilePath, 'utf8'))
  const nonPassed = selectNonPassedTestFiles(jestJson)
  const totalTestFiles = Array.isArray(jestJson.testResults) ? jestJson.testResults.length : 0

  process.stderr.write(`[test-flake] full suite: ${totalTestFiles} files, ${nonPassed.length} not passed.\n`)

  const failures = []
  for (const entry of nonPassed) {
    const rerunRunId = generateRunId()
    process.stderr.write(`[test-flake] solo rerun: ${entry.file} (run id ${rerunRunId})...\n`)
    const rerunRes = spawnApiTest(['--runTestsByPath', entry.file], { ...process.env, CROWI_TEST_RUN_ID: rerunRunId })
    const classification = classifyRerunExitCode(rerunRes.status ?? 1)
    failures.push({
      file: entry.file,
      classification,
      fullSuiteStatus: entry.status,
      firstFailureMessage: entry.message,
      rerunExitCode: rerunRes.status ?? null,
    })
    // `::error::` / `::warning::` are GitHub Actions workflow-command
    // annotations — harmless no-ops outside CI, but this is exactly the
    // "identifiable via annotation or log" surface the non-blocking CI job
    // needs (a `continue-on-error: true` step still shows these).
    if (classification === 'REGRESSION') {
      console.log(`::error file=${entry.file}::REGRESSION — ${entry.file} fails standalone too, not just under full-suite load`)
    } else {
      console.log(`::warning file=${entry.file}::FLAKY — ${entry.file} failed under the full suite but passed standalone`)
    }
  }

  const nearMissEventsPath = resolveNearMissEventsPath(runId)
  let nearMiss = []
  if (existsSync(nearMissEventsPath)) {
    const { events, warnings } = parseNearMissJsonl(readFileSync(nearMissEventsPath, 'utf8'))
    for (const warning of warnings) process.stderr.write(`[test-flake] ${warning}\n`)
    nearMiss = groupNearMissByFile(events)
  }

  const report = buildReport({
    runId,
    generatedAt: new Date().toISOString(),
    fullSuiteOutputFile: outputFilePath,
    totalTestFiles,
    failures,
    nearMiss,
  })

  console.log(JSON.stringify(report, null, 2))

  const hasRegression = failures.some((failure) => failure.classification === 'REGRESSION')
  process.exitCode = hasRegression ? 1 : 0
}

// `import.meta.main` is Node 24+ (this repo's `engines.node`, same guard
// `migrate.mjs` uses) — lets `test-flake-report.test.mjs` import the pure
// helpers above without triggering a real full-suite run.
if (import.meta.main) {
  main()
}
