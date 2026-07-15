#!/usr/bin/env node
// CI `test` job step (feature-flake-report-detection-redesign, AC-1/AC-2):
// runs AFTER `pnpm test` completes — pass, fail, OR partially-crashed — and
// writes the manifest `scripts/test-flake-report-consume.mjs` (the
// `flake-report` job) later downloads and verifies. This script does NOT
// run any tests itself; it only records what the ALREADY-RUN `pnpm test`
// left behind:
//
//   - `@crowi/api` jest's `--json --outputFile` result, at the deterministic
//     path `flake-report-shared.mjs`'s `resolveApiJestOutputPath(runId)`
//     resolves — written by `packages/api`'s `test` script ONLY when
//     `CROWI_TEST_JSON_OUTPUT_FILE` is set (CI-limited; local `pnpm test`
//     is unaffected — see that package's `package.json`).
//   - the near-miss JSONL side channel, at
//     `resolveNearMissEventsPath(runId)` — written unconditionally by
//     `packages/api/src/test/db-connect-retry.ts` whenever a connect retry
//     fires, independent of the `--json` flag above.
//
// `CROWI_TEST_RUN_ID` is required (the `.github/workflows/ci.yml` `test`
// job sets it, via `$GITHUB_ENV`, before `pnpm test` — AC-1) and both
// artifact paths are DETERMINISTIC functions of it, so this script never
// globs — it only ever checks the two exact paths the CI workflow already
// agreed on. `.github/workflows/ci.yml`'s "Upload flake-report artifact"
// step (which runs after this one, also `if: always()`) uploads whatever
// this manifest says was written — a missing file is simply recorded as
// `*Written: false`, not an error.
//
// Fail-open (this bookkeeping step must NEVER affect the `test` job's own
// red/green — AC-6's "test job の赤/緑は変えない"): every failure path here
// only ever logs and returns, never sets a non-zero `process.exitCode`.
// `.github/workflows/ci.yml` additionally marks this step
// `continue-on-error: true` as belt-and-suspenders.

import { existsSync, renameSync, writeFileSync } from 'node:fs'

import { buildManifest, resolveApiJestOutputPath, resolveManifestPath, resolveNearMissEventsPath } from './flake-report-shared.mjs'

function main() {
  const runId = process.env.CROWI_TEST_RUN_ID
  if (!runId || !runId.trim()) {
    process.stderr.write(
      '[flake-report-produce] CROWI_TEST_RUN_ID is unset — the CI workflow should have set it before `pnpm test` ' +
        'ran (see .github/workflows/ci.yml). Skipping the manifest (fail-open: this must never affect the test job).\n',
    )
    return
  }

  try {
    const apiJestOutputFile = resolveApiJestOutputPath(runId)
    const nearMissEventsFile = resolveNearMissEventsPath(runId)
    const apiJestOutputFileWritten = existsSync(apiJestOutputFile)
    const nearMissEventsFileWritten = existsSync(nearMissEventsFile)

    const manifest = buildManifest({
      runId,
      generatedAt: new Date().toISOString(),
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      apiJestOutputFile,
      apiJestOutputFileWritten,
      nearMissEventsFile,
      nearMissEventsFileWritten,
    })

    // Write to a run-scoped temp path first, then rename into place — a
    // rename within the same directory (both under `os.tmpdir()`) is atomic
    // on POSIX, so an interruption mid-write (job cancelled, runner killed)
    // can never leave a PARTIAL manifest at the path the "Upload flake-report
    // artifact" step below reads from; the consumer either sees the fully
    // written manifest or none at all (handled the same as "artifact
    // missing", AC-5), never a truncated/corrupt one.
    const manifestPath = resolveManifestPath(runId)
    const manifestTmpPath = `${manifestPath}.tmp-${process.pid}`
    writeFileSync(manifestTmpPath, JSON.stringify(manifest, null, 2))
    renameSync(manifestTmpPath, manifestPath)
    process.stderr.write(
      `[flake-report-produce] wrote manifest for run ${runId} (@crowi/api jest --json output ` +
        `${apiJestOutputFileWritten ? 'present' : 'MISSING'}, near-miss events ${nearMissEventsFileWritten ? 'present' : 'none'}).\n`,
    )
  } catch (err) {
    // Fail-open — see the top comment: this bookkeeping step must never
    // fail the `test` job, no matter what goes wrong here.
    process.stderr.write(`[flake-report-produce] failed to write the manifest (fail-open, not failing the job): ${err.message}\n`)
  }
}

// `import.meta.main` is Node 24+ (this repo's `engines.node`) — no pure
// helpers are exported here (this script is IO glue only, see the top
// comment); `buildManifest`/path formulas it calls are already unit-tested
// in `flake-report-shared.test.mjs`.
if (import.meta.main) {
  main()
}
