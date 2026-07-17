// Unit tests for the pure decision-tree helpers in
// scripts/test-flake-report-consume.mjs (feature-flake-report-detection-redesign
// AC-2/AC-4/AC-5/AC-6). `main()` (artifact I/O + real solo-rerun spawns) is
// glue, not covered here — same untested-`main()` precedent as
// `test-flake-report.mjs` / `migrate.mjs`.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildManifest, resolveApiJestOutputPath, resolveClassificationReportPath, resolveNearMissEventsPath } from './flake-report-shared.mjs'
import {
  buildStepSummaryMarkdown,
  classifyApiJestEvidence,
  decideProvenance,
  parseJestJson,
  resolveNearMissEvidence,
  summarizeClassifications,
  verifyManifest,
} from './test-flake-report-consume.mjs'

describe('decideProvenance', () => {
  it('reports cancelled when the test job was cancelled', () => {
    const result = decideProvenance({ testJobResult: 'cancelled', artifactAvailable: true })
    assert.equal(result.status, 'cancelled')
  })

  it('reports cancelled when the test job was skipped', () => {
    const result = decideProvenance({ testJobResult: 'skipped', artifactAvailable: true })
    assert.equal(result.status, 'cancelled')
  })

  it('reports source-unavailable when the artifact could not be downloaded, even if the test job succeeded', () => {
    const result = decideProvenance({ testJobResult: 'success', artifactAvailable: false })
    assert.equal(result.status, 'source-unavailable')
  })

  it('reports source-unavailable when the artifact could not be downloaded, even if the test job failed', () => {
    const result = decideProvenance({ testJobResult: 'failure', artifactAvailable: false })
    assert.equal(result.status, 'source-unavailable')
  })

  it('proceeds when the test job succeeded (or failed) and the artifact is available', () => {
    assert.equal(decideProvenance({ testJobResult: 'success', artifactAvailable: true }).status, 'proceed')
    assert.equal(decideProvenance({ testJobResult: 'failure', artifactAvailable: true }).status, 'proceed')
  })
})

describe('parseJestJson', () => {
  it('parses valid jest --json output', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [] }))
    assert.equal(error, null)
    assert.deepEqual(json, { testResults: [] })
  })

  it('reports a parse error instead of throwing on corrupted content', () => {
    const { json, error } = parseJestJson('{not valid json')
    assert.equal(json, null)
    assert.match(error, /could not be parsed/)
  })

  it('rejects valid-JSON-but-wrong-shape content (empty object) instead of silently treating it as a clean run', () => {
    const { json, error } = parseJestJson('{}')
    assert.equal(json, null)
    assert.match(error, /not a recognizable jest result/)
  })

  it('rejects valid JSON whose testResults is not an array', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: 'nope' }))
    assert.equal(json, null)
    assert.match(error, /not a recognizable jest result/)
  })

  it('rejects a bare JSON array (valid JSON, not an object)', () => {
    const { json, error } = parseJestJson('[]')
    assert.equal(json, null)
    assert.match(error, /not a recognizable jest result/)
  })

  it('rejects a null entry inside testResults instead of throwing (the exact { testResults: [null] } shape that used to crash classification)', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [null] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[0\]/)
    assert.match(error, /not a recognizable per-file result/)
  })

  it('rejects a non-object (string) entry inside testResults', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: ['not-an-object'] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[0\]/)
  })

  it('rejects an entry missing a string name', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [{ status: 'passed' }] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[0\]/)
  })

  it('rejects an entry missing a string status', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [{ name: 'a.test.ts' }] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[0\]/)
  })

  it('rejects an entry whose name/status are the wrong type (non-string)', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [{ name: 123, status: true }] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[0\]/)
  })

  it('flags the FIRST malformed entry even when it follows well-formed ones', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [{ name: 'a.test.ts', status: 'passed' }, null] }))
    assert.equal(json, null)
    assert.match(error, /testResults\[1\]/)
  })

  it('accepts a testResults array whose entries all have string name/status, regardless of extra fields', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [{ name: 'a.test.ts', status: 'failed', message: 'boom', extra: { nested: true } }] }))
    assert.equal(error, null)
    assert.equal(json.testResults.length, 1)
  })
})

describe('parseJestJson + classifyApiJestEvidence integration (the exact reviewer-flagged crash path)', () => {
  it('a { testResults: [null] } document degrades to inconclusive-no-evidence, not a thrown TypeError reading result.status', () => {
    const { json, error } = parseJestJson(JSON.stringify({ testResults: [null] }))
    const manifest = { apiJest: { outputFileWritten: true } }
    // Must not throw — this is the exact call sequence `main()` performs.
    const result = classifyApiJestEvidence({ manifest, jestJsonParseResult: { json, error }, testJobResult: 'failure' })
    assert.equal(result.status, 'inconclusive-no-evidence')
    assert.deepEqual(result.nonPassed, [])
  })
})

describe('verifyManifest', () => {
  // Built from the SAME deterministic path formulas the producer uses (not
  // hardcoded `/tmp/...` strings) — `os.tmpdir()` isn't `/tmp` on every OS
  // (e.g. macOS dev machines), and this manifest must also pass the
  // run-ID/path correlation check (`verifyManifestPaths`) added below.
  const validManifest = buildManifest({
    runId: '123-abc',
    generatedAt: '2026-01-01T00:00:00.000Z',
    workflowRunId: '999',
    workflowRunAttempt: '1',
    apiJestOutputFile: resolveApiJestOutputPath('123-abc'),
    apiJestOutputFileWritten: true,
    nearMissEventsFile: resolveNearMissEventsPath('123-abc'),
    nearMissEventsFileWritten: false,
  })

  it('accepts a manifest whose runId matches the expected id', () => {
    const result = verifyManifest({ manifestRaw: JSON.stringify(validManifest), expectedRunId: '123-abc' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.manifest, validManifest)
  })

  it('rejects a manifest whose runId does not match (a foreign/stale artifact)', () => {
    const result = verifyManifest({ manifestRaw: JSON.stringify(validManifest), expectedRunId: '999-xyz' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not match/)
  })

  it('rejects when the manifest content is missing entirely', () => {
    const result = verifyManifest({ manifestRaw: null, expectedRunId: '123-abc' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /could not be read/)
  })

  it('rejects malformed manifest JSON', () => {
    const result = verifyManifest({ manifestRaw: 'not json', expectedRunId: '123-abc' })
    assert.equal(result.ok, false)
  })

  it('rejects a manifest whose runId matches but apiJest.outputFile points at an unrelated path (AC-2 path correlation)', () => {
    const foreignPathManifest = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: '/tmp/some-other-runs-result.json',
      apiJestOutputFileWritten: true,
      nearMissEventsFile: resolveNearMissEventsPath('123-abc'),
      nearMissEventsFileWritten: false,
    })
    const result = verifyManifest({ manifestRaw: JSON.stringify(foreignPathManifest), expectedRunId: '123-abc' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /apiJest\.outputFile/)
  })
})

describe('classifyApiJestEvidence', () => {
  it('returns inconclusive-no-evidence when the producer never wrote the jest --json output', () => {
    const manifest = { apiJest: { outputFileWritten: false } }
    const result = classifyApiJestEvidence({ manifest, jestJsonParseResult: { json: null, error: null }, testJobResult: 'failure' })
    assert.equal(result.status, 'inconclusive-no-evidence')
    assert.deepEqual(result.nonPassed, [])
  })

  it('returns inconclusive-no-evidence when the jest --json output could not be parsed', () => {
    const manifest = { apiJest: { outputFileWritten: true } }
    const result = classifyApiJestEvidence({ manifest, jestJsonParseResult: { json: null, error: 'corrupted' }, testJobResult: 'failure' })
    assert.equal(result.status, 'inconclusive-no-evidence')
    assert.equal(result.reason, 'corrupted')
  })

  it('returns non-api-failure when the api suite is clean but the test job still failed', () => {
    const manifest = { apiJest: { outputFileWritten: true } }
    const result = classifyApiJestEvidence({
      manifest,
      jestJsonParseResult: { json: { testResults: [{ name: 'a.test.ts', status: 'passed' }] }, error: null },
      testJobResult: 'failure',
    })
    assert.equal(result.status, 'non-api-failure')
    assert.match(result.reason, /different step\/package failed/)
  })

  it('returns classified with an empty nonPassed list on a genuinely green run', () => {
    const manifest = { apiJest: { outputFileWritten: true } }
    const result = classifyApiJestEvidence({
      manifest,
      jestJsonParseResult: { json: { testResults: [{ name: 'a.test.ts', status: 'passed' }] }, error: null },
      testJobResult: 'success',
    })
    assert.equal(result.status, 'classified')
    assert.deepEqual(result.nonPassed, [])
  })

  it('returns classified with the non-pass files when the api suite itself had failures', () => {
    const manifest = { apiJest: { outputFileWritten: true } }
    const result = classifyApiJestEvidence({
      manifest,
      jestJsonParseResult: { json: { testResults: [{ name: 'a.test.ts', status: 'failed', message: 'boom' }] }, error: null },
      testJobResult: 'failure',
    })
    assert.equal(result.status, 'classified')
    assert.deepEqual(result.nonPassed, [{ file: 'a.test.ts', status: 'failed', message: 'boom' }])
  })
})

describe('summarizeClassifications', () => {
  it('counts each classification bucket', () => {
    const files = [{ classification: 'FLAKY' }, { classification: 'FLAKY' }, { classification: 'REGRESSION' }, { classification: 'INCONCLUSIVE' }]
    assert.deepEqual(summarizeClassifications(files), { FLAKY: 2, REGRESSION: 1, INCONCLUSIVE: 1 })
  })

  it('returns all-zero counts for an empty list', () => {
    assert.deepEqual(summarizeClassifications([]), { FLAKY: 0, REGRESSION: 0, INCONCLUSIVE: 0 })
  })
})

describe('resolveNearMissEvidence', () => {
  it('reports not-fired when the manifest says the near-miss file was never written (no retry fired — a complete-evidence green case)', () => {
    const manifest = { nearMiss: { eventsFileWritten: false } }
    const result = resolveNearMissEvidence({ manifest, nearMissRaw: null })
    assert.equal(result.status, 'not-fired')
    assert.deepEqual(result.nearMiss, [])
  })

  it('reports unavailable (not the same as not-fired) when the manifest says the file WAS written but it is missing from the downloaded artifact', () => {
    const manifest = { nearMiss: { eventsFileWritten: true } }
    const result = resolveNearMissEvidence({ manifest, nearMissRaw: null })
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.nearMiss, [])
    assert.match(result.reason, /not present in the downloaded artifact/)
  })

  it('reports available and groups events when the file was written and successfully downloaded', () => {
    const manifest = { nearMiss: { eventsFileWritten: true } }
    const raw = `${JSON.stringify({ testFilePath: '/repo/a.test.ts' })}\n`
    const result = resolveNearMissEvidence({ manifest, nearMissRaw: raw })
    assert.equal(result.status, 'available')
    assert.equal(result.nearMiss.length, 1)
    assert.equal(result.nearMiss[0].testFilePath, '/repo/a.test.ts')
  })
})

describe('buildStepSummaryMarkdown', () => {
  const base = { runId: '123-abc', testJobResult: 'failure', counts: { FLAKY: 0, REGRESSION: 0, INCONCLUSIVE: 0 }, files: [], nearMiss: [] }

  it('renders a cancelled report distinctly (never as green)', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'cancelled', reason: 'the "test" job was cancelled' })
    assert.match(md, /\*\*cancelled\*\*/)
    assert.doesNotMatch(md, /No non-pass/)
  })

  it('renders partial per-file classification alongside a cancelled report when some files were classified before cancellation', () => {
    const md = buildStepSummaryMarkdown({
      ...base,
      status: 'cancelled',
      reason: 'this flake-report job itself was cancelled during solo-rerun classification (1/2 file(s) classified before cancellation, 1 not rerun)',
      counts: { FLAKY: 0, REGRESSION: 0, INCONCLUSIVE: 1 },
      files: [{ file: 'a.test.ts', classification: 'INCONCLUSIVE', reason: 'solo rerun was terminated by signal SIGTERM' }],
    })
    assert.match(md, /\*\*cancelled\*\*/)
    assert.match(md, /Partial classification before cancellation/)
    assert.match(md, /a\.test\.ts/)
  })

  it('renders a source-unavailable report distinctly (never as green)', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'source-unavailable', reason: 'artifact missing' })
    assert.match(md, /\*\*source unavailable\*\*/)
    assert.match(md, /Not shown as green/)
  })

  it('renders a non-api-failure report distinctly (never as green)', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'non-api-failure', reason: 'web failed' })
    assert.match(md, /out of scope \(non-API failure\)/)
  })

  it('renders an inconclusive-no-evidence report distinctly', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'inconclusive-no-evidence', reason: 'no json' })
    assert.match(md, /\*\*INCONCLUSIVE\*\*/)
  })

  it('renders a classified report with a per-file table and counts', () => {
    const md = buildStepSummaryMarkdown({
      ...base,
      status: 'classified',
      reason: null,
      counts: { FLAKY: 1, REGRESSION: 1, INCONCLUSIVE: 0 },
      files: [
        { file: 'a.test.ts', classification: 'FLAKY', reason: null },
        { file: 'b.test.ts', classification: 'REGRESSION', reason: null },
      ],
    })
    assert.match(md, /FLAKY: 1 · REGRESSION: 1 · INCONCLUSIVE: 0/)
    assert.match(md, /a\.test\.ts/)
    assert.match(md, /b\.test\.ts/)
  })

  it('renders "no non-pass files" for a classified report with an empty file list', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'classified', reason: null })
    assert.match(md, /No non-pass @crowi\/api jest files/)
  })

  it('includes a near-miss section when present', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'classified', reason: null, nearMiss: [{ testFilePath: 'c.test.ts', count: 2 }] })
    assert.match(md, /near-miss/)
    assert.match(md, /c\.test\.ts/)
  })

  it('renders a distinct "near-miss data unavailable" notice, not a silent empty table, when nearMissStatus is unavailable', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'classified', reason: null, nearMiss: [], nearMissStatus: 'unavailable' })
    assert.match(md, /near-miss data unavailable/)
    assert.match(md, /NOT "no retries fired"/)
  })

  it('renders no near-miss section at all when nearMissStatus is not-fired and nearMiss is empty', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'classified', reason: null, nearMiss: [], nearMissStatus: 'not-fired' })
    assert.doesNotMatch(md, /near-miss/)
  })

  it('states the producer scope (@crowi/api jest only) up front — AC-6', () => {
    const md = buildStepSummaryMarkdown({ ...base, status: 'classified', reason: null })
    assert.match(md, /@crowi\/api jest only/)
  })
})

describe('main() cancellation mid solo-rerun (real subprocess + real SIGTERM — AC-5)', () => {
  // Spawns the ACTUAL consumer script as a child process (not an in-process
  // call to `main()`) — this is the only way to exercise a real OS SIGTERM
  // and this process's own `process.once('SIGTERM', ...)` handler, which is
  // what the previous review round found missing (a synchronous `spawnSync`
  // solo-rerun blocked the event loop for the whole rerun, so no signal
  // handler could ever run mid-loop). A fake `pnpm` on `PATH` stands in for
  // the real `pnpm --filter @crowi/api test --runTestsByPath <file>` solo
  // rerun — it just sleeps, so it is reliably still alive when this test
  // sends SIGTERM, without needing an actual `@crowi/api` jest invocation.
  it('emits a cancelled classification report artifact instead of dying silently when killed mid solo-rerun', async () => {
    const runId = `test-cancel-${process.pid}-${Date.now().toString(36)}`
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'crowi-flake-cancel-test-'))
    const fakeBinDir = path.join(scratchDir, 'bin')
    mkdirSync(fakeBinDir)
    const fakePnpmPath = path.join(fakeBinDir, 'pnpm')
    writeFileSync(fakePnpmPath, '#!/bin/sh\nsleep 30\n')
    chmodSync(fakePnpmPath, 0o755)

    const artifactDir = path.join(scratchDir, 'artifact')
    mkdirSync(artifactDir)
    const manifest = buildManifest({
      runId,
      generatedAt: new Date().toISOString(),
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: resolveApiJestOutputPath(runId),
      apiJestOutputFileWritten: true,
      nearMissEventsFile: resolveNearMissEventsPath(runId),
      nearMissEventsFileWritten: false,
    })
    writeFileSync(path.join(artifactDir, `crowi-flake-report-manifest.${runId}.json`), JSON.stringify(manifest))
    writeFileSync(
      path.join(artifactDir, path.basename(manifest.apiJest.outputFile)),
      JSON.stringify({ testResults: [{ name: 'fake.test.ts', status: 'failed', message: 'boom' }] }),
    )

    const reportPath = resolveClassificationReportPath(runId)
    const scriptPath = fileURLToPath(new URL('./test-flake-report-consume.mjs', import.meta.url))
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))

    const child = spawn('node', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        CROWI_TEST_RUN_ID: runId,
        CROWI_FLAKE_REPORT_TEST_JOB_RESULT: 'failure',
        CROWI_FLAKE_REPORT_ARTIFACT_DIR: artifactDir,
        CROWI_FLAKE_REPORT_ARTIFACT_DOWNLOAD_OUTCOME: 'success',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.resume() // drain, unused by the assertions below

    let stderrSoFar = ''
    let sigtermSent = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrSoFar += chunk
      if (!sigtermSent && stderrSoFar.includes('solo rerun: fake.test.ts')) {
        sigtermSent = true
        child.kill('SIGTERM')
      }
    })

    try {
      await new Promise((resolve, reject) => {
        // Genuine-failure backstop only, NOT a pacing window: everything this
        // test waits for is event-driven (the stderr marker triggers the
        // SIGTERM, the child's own `exit` resolves), so this timer exists
        // solely to convert a truly-hung child into a failure instead of
        // hanging `node --test` (which has no per-test timeout) forever. It
        // must therefore be sized orders of magnitude above any slow-but-
        // correct run: at 10s it flaked on a loaded CI runner where node
        // startup + script import alone blew the window (run 29601027804 —
        // the same fixed-deadline race class as #917, in the flake pipeline's
        // own test).
        const hardTimeout = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`consumer subprocess did not exit after SIGTERM within this test's own safety timeout (stderr so far: ${stderrSoFar})`))
        }, 120_000)
        child.once('exit', () => {
          clearTimeout(hardTimeout)
          resolve()
        })
      })

      assert.ok(sigtermSent, 'the solo-rerun marker was never observed on stderr — this test never actually exercised the cancellation path')
      assert.ok(existsSync(reportPath), 'the consumer must still write its classification report artifact after being cancelled mid solo-rerun (AC-5)')
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      assert.equal(report.status, 'cancelled')
      assert.match(report.reason, /cancelled during solo-rerun classification/)
      assert.equal(report.files.length, 1)
      assert.equal(report.files[0].file, 'fake.test.ts')
      assert.equal(report.files[0].classification, 'INCONCLUSIVE')
    } finally {
      rmSync(reportPath, { force: true })
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
