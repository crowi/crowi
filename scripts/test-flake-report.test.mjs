// Unit tests for scripts/test-flake-report.mjs (feature-test-parallel-db-flake-hardening,
// Phase 4 / B2; classification/path helpers now live in flake-report-shared.mjs,
// shared with the CI producer/consumer split — feature-flake-report-detection-redesign).
// Run with `node --test` (see dev-ports.test.mjs for the rationale). Only pure
// functions are covered here — `main()` spawns the real `@crowi/api` full
// suite (and one solo rerun per failure), which isn't worth faking;
// `migrate.mjs`'s untested `main()` is the same precedent.
//
// AC2's near-miss "end-to-end" requirement is split across two real,
// non-mocked filesystem tests in two different places, since the writer and
// the reader live in two different module systems that can't cleanly import
// each other (`db-connect-retry.ts` is ts-jest/CJS inside `packages/api`;
// this script is plain Node ESM at the repo root):
//   - the WRITE side (a retry really appends one JSONL row to
//     `resolveRetryEventsPath()`) is `db-connect-retry.test.ts`'s existing
//     "appends one JSON Lines row ... to the run-scoped side channel" test —
//     a real `appendFileSync` + `readFileSync` round trip, not a mock.
//   - the READ side (this file's "near-miss end-to-end" describe block
//     below) writes a real JSONL file to the EXACT path
//     `resolveNearMissEventsPath()` resolves (the independent duplicate of
//     that same path formula — see `flake-report-shared.mjs`'s doc comment)
//     and reads it back through `parseNearMissJsonl` + `groupNearMissByFile`,
//     with real `fs` I/O, not an in-memory string.
// Together they cover "a retry appends a row" and "the report reflects it"
// without needing a live full-suite run to actually trigger a transient
// connect failure (which isn't reliably reproducible on demand — seeding a
// real DB outage mid-suite would make this test itself flaky).

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { groupNearMissByFile, parseNearMissJsonl, resolveNearMissEventsPath } from './flake-report-shared.mjs'
import { buildReport } from './test-flake-report.mjs'

describe('buildReport', () => {
  it('assembles the final structured report shape', () => {
    const report = buildReport({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      fullSuiteOutputFile: '/tmp/out.json',
      totalTestFiles: 140,
      failures: [{ file: '/repo/a.test.ts', classification: 'FLAKY', reason: null, fullSuiteStatus: 'failed', firstFailureMessage: 'x', rerunExitCode: 0, rerunSignal: null }],
      nearMiss: [{ testFilePath: '/repo/b.test.ts', count: 1, events: [{ testFilePath: '/repo/b.test.ts' }] }],
    })
    assert.deepEqual(report, {
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      fullSuite: { outputFile: '/tmp/out.json', totalTestFiles: 140, nonPassedCount: 1 },
      failures: [{ file: '/repo/a.test.ts', classification: 'FLAKY', reason: null, fullSuiteStatus: 'failed', firstFailureMessage: 'x', rerunExitCode: 0, rerunSignal: null }],
      nearMiss: [{ testFilePath: '/repo/b.test.ts', count: 1, events: [{ testFilePath: '/repo/b.test.ts' }] }],
    })
  })
})

describe('near-miss end-to-end (real file I/O, mirrors the path db-connect-retry.ts writes to)', () => {
  it('reads and groups a near-miss JSONL file written to the exact path resolveNearMissEventsPath() resolves', () => {
    const runId = `test-flake-report-e2e-${process.pid}-${Date.now().toString(36)}`
    const eventsPath = resolveNearMissEventsPath(runId)
    // Same shape `db-connect-retry.ts`'s `recordRetry()` writes: one JSON
    // object per line — `timestamp` / `testFilePath` / `attempt` /
    // `errnoOrClass` / `message`.
    const rows = [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        testFilePath: '/repo/packages/api/src/hono/handlers/page.test.ts',
        attempt: 1,
        errnoOrClass: 'ETIMEDOUT',
        message: 'Cannot connect to Database Server: connect ETIMEDOUT 127.0.0.1:27018',
      },
    ]
    writeFileSync(eventsPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    try {
      assert.ok(existsSync(eventsPath))
      const { events, warnings } = parseNearMissJsonl(readFileSync(eventsPath, 'utf8'))
      assert.equal(warnings.length, 0)
      const grouped = groupNearMissByFile(events)
      assert.deepEqual(grouped, [
        {
          testFilePath: '/repo/packages/api/src/hono/handlers/page.test.ts',
          count: 1,
          events: rows,
        },
      ])
    } finally {
      rmSync(eventsPath, { force: true })
    }
  })
})
