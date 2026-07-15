#!/usr/bin/env node
// `pnpm test:flake` — opt-in, LOCAL, full-suite flake detector for
// `@crowi/api` (feature-test-parallel-db-flake-hardening, Phase 4 / B2).
//
// ── CI note (feature-flake-report-detection-redesign) ──
//
// This script used to ALSO be what CI's `flake-report` job ran (a second,
// independent full-suite invocation, separate from the `test` job's own
// `pnpm test`). That was the redesign's core bug (GAP 1): the independent
// run could — and in practice did — observe a DIFFERENT outcome than the
// run that actually gated `test`, so `flake-report` was classifying flakes
// nobody's `test` job ever saw. CI now uses a producer/consumer pair
// instead — `scripts/test-flake-report-produce.mjs` (in the `test` job,
// `if: always()`, writes a manifest + artifact from the SAME run that
// gates `test`) and `scripts/test-flake-report-consume.mjs` (in
// `flake-report`, downloads that artifact and solo-reruns only the files
// `@crowi/api` jest itself did not pass — see `.github/workflows/ci.yml`).
//
// This script remains as a LOCAL, ad hoc diagnostic (`pnpm test:flake`): a
// developer who wants to check the whole suite's flakiness without waiting
// for a CI run can still run it directly. Running its own independent full
// suite is fine here — there is no separate "real" run it could disagree
// with, unlike the CI case above.
//
// Root `pnpm test` is `turbo run test --concurrency=3`: a package-by-package
// dispatch where every workspace's jest is its own independent child process,
// not one process this script could feed a single `--json --outputFile` to.
// So this script spawns `@crowi/api`'s jest DIRECTLY — `pnpm --filter
// @crowi/api test --json --outputFile=<path>` — bypassing turbo entirely.
// `@crowi/collab` / `@crowi/plugin-search-mongo` are deliberately OUT of
// scope (see the spec's "やらないこと" — B2/the redesign are both
// `@crowi/api`-only).
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
// classify each rerun outcome as FLAKY / REGRESSION / INCONCLUSIVE (AC-4 of
// the redesign — see `flake-report-shared.mjs`'s `classifyRerunOutcome`).
// This is a fail → solo-rerun CLASSIFIER, not a retry: jest's own
// `retryTimes` (silently re-running a test body until it goes green) is
// deliberately NOT used anywhere in this repo — that would hide the very
// signal this script exists to surface. The bounded CONNECT retry in
// `src/test/db-connect-retry.ts` (Phase 1 / A1) is a different, narrower
// layer: it retries only `beforeAll`'s DB boot step, and only for a specific
// transient-network failure class — this script doesn't touch that decision
// at all, it only reads its output (see "near-miss" below).
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
// `flake-report-shared.mjs`'s `resolveNearMissEventsPath()`, an independent
// duplicate of `db-connect-retry.ts`'s `resolveRetryEventsPath()` — a root
// `.mjs` script can't import a `packages/api/src/test/*.ts` module, and
// `packages/api`'s build output doesn't ship test-only files anyway).
//
// This script sets `CROWI_TEST_RUN_ID` itself (generated fresh, unless the
// caller already set one) in the full-suite child's env BEFORE spawning it —
// `global-setup.js`'s `process.env.CROWI_TEST_RUN_ID ??= ...` self-generation
// exists specifically so an external orchestrator like this one can supply
// the value first (see that file's doc comment). Because the spawn is direct
// (not through turbo), the value reaches the child as a normal inherited env
// var — no `turbo.json` `globalPassThroughEnv` entry is needed for THIS
// local tool (CI's producer/consumer redesign added one for its own,
// turbo-mediated `pnpm test` — see `turbo.json`). Each solo rerun gets its
// OWN freshly generated run id — reusing the full-suite's id would let a
// rerun's own connect retries (if any) pollute the ORIGINAL run's near-miss
// count for a failure that has nothing to do with the near-miss signal this
// report is trying to measure.
//
// ── placement ──
//
// Local only: `pnpm test:flake` (this script, registered as a plain
// non-turbo script — no `turbo.json` task). NOT wired into the pre-push
// hook (this repeats the ENTIRE suite plus one rerun per failure — too slow
// to gate every push).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  annotateClassification,
  classifyRerunOutcome,
  generateRunId,
  groupNearMissByFile,
  parseNearMissJsonl,
  resolveNearMissEventsPath,
  selectNonPassedTestFiles,
} from './flake-report-shared.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/**
 * `capture: true` returns stdout/stderr as strings (needed for a solo
 * rerun's `classifyRerunOutcome` stderr pattern-matching) instead of
 * streaming straight to the terminal — the caller re-emits both afterward so
 * nothing is lost, just buffered one file at a time.
 */
function spawnApiTest(extraArgs, env, { capture = false } = {}) {
  // NO literal `--` before `extraArgs` — see this file's top comment.
  const spawnOptions = capture ? { cwd: repoRoot, env, encoding: 'utf8' } : { cwd: repoRoot, env, stdio: 'inherit' }
  return spawnSync('pnpm', ['--filter', '@crowi/api', 'test', ...extraArgs], spawnOptions)
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
    const rerunRes = spawnApiTest(['--runTestsByPath', entry.file], { ...process.env, CROWI_TEST_RUN_ID: rerunRunId }, { capture: true })
    if (rerunRes.stdout) process.stdout.write(rerunRes.stdout)
    if (rerunRes.stderr) process.stderr.write(rerunRes.stderr)
    const { classification, reason } = classifyRerunOutcome({ status: rerunRes.status, signal: rerunRes.signal, error: rerunRes.error, stderr: rerunRes.stderr })
    failures.push({
      file: entry.file,
      classification,
      reason,
      fullSuiteStatus: entry.status,
      firstFailureMessage: entry.message,
      rerunExitCode: rerunRes.status ?? null,
      rerunSignal: rerunRes.signal ?? null,
    })
    // `::error::` / `::warning::` are GitHub Actions workflow-command
    // annotations — harmless no-ops outside CI, but a useful signal when
    // this script is ever run from a CI context (identifiable via
    // annotation or log).
    annotateClassification(classification, entry.file, reason, { regressionContext: 'under full-suite load', flakyContext: 'failed under the full suite' })
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
