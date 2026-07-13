// Unit tests for the pure classification/parsing helpers in
// scripts/test-flake-report.mjs (feature-test-parallel-db-flake-hardening,
// Phase 4 / B2). Run with `node --test` (see dev-ports.test.mjs for the
// rationale). Only pure functions are covered here — `main()` spawns the
// real `@crowi/api` full suite (and one solo rerun per failure), which isn't
// worth faking; `migrate.mjs`'s untested `main()` is the same precedent.
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
//     that same path formula — see this module's doc comment) and reads it
//     back through `parseNearMissJsonl` + `groupNearMissByFile`, with real
//     `fs` I/O, not an in-memory string.
// Together they cover "a retry appends a row" and "the report reflects it"
// without needing a live full-suite run to actually trigger a transient
// connect failure (which isn't reliably reproducible on demand — seeding a
// real DB outage mid-suite would make this test itself flaky).

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  buildReport,
  classifyRerunExitCode,
  generateRunId,
  groupNearMissByFile,
  parseNearMissJsonl,
  resolveNearMissEventsPath,
  selectNonPassedTestFiles,
} from './test-flake-report.mjs'

describe('generateRunId', () => {
  it('returns a `<pid>-<base36 timestamp>` string', () => {
    const runId = generateRunId()
    assert.match(runId, /^\d+-[0-9a-z]+$/)
    assert.equal(runId.split('-')[0], String(process.pid))
  })

  it('generates a different id on each call (timestamp advances or at least is re-sampled)', async () => {
    const first = generateRunId()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = generateRunId()
    assert.notEqual(first, second)
  })
})

describe('resolveNearMissEventsPath', () => {
  it('matches the `crowi-api-test-retry-events.<runId>.jsonl` formula db-connect-retry.ts uses', () => {
    const runId = '12345-abc123'
    const resolved = resolveNearMissEventsPath(runId)
    assert.ok(resolved.endsWith(`crowi-api-test-retry-events.${runId}.jsonl`))
  })
})

describe('selectNonPassedTestFiles', () => {
  it('returns only non-passed files, preserving order', () => {
    const jestJson = {
      testResults: [
        { name: '/repo/src/a.test.ts', status: 'passed', message: '' },
        { name: '/repo/src/b.test.ts', status: 'failed', message: 'boom' },
        { name: '/repo/src/c.test.ts', status: 'passed', message: '' },
        { name: '/repo/src/d.test.ts', status: 'failed', message: 'kaboom' },
      ],
    }
    assert.deepEqual(selectNonPassedTestFiles(jestJson), [
      { file: '/repo/src/b.test.ts', status: 'failed', message: 'boom' },
      { file: '/repo/src/d.test.ts', status: 'failed', message: 'kaboom' },
    ])
  })

  it('treats jest statuses other than passed (skipped/focused) as non-passed too', () => {
    const jestJson = {
      testResults: [
        { name: '/repo/src/a.test.ts', status: 'skipped', message: '' },
        { name: '/repo/src/b.test.ts', status: 'focused', message: '' },
      ],
    }
    assert.deepEqual(selectNonPassedTestFiles(jestJson).map((r) => r.file), ['/repo/src/a.test.ts', '/repo/src/b.test.ts'])
  })

  it('returns an empty array for a fully green run', () => {
    const jestJson = { testResults: [{ name: '/repo/src/a.test.ts', status: 'passed', message: '' }] }
    assert.deepEqual(selectNonPassedTestFiles(jestJson), [])
  })

  it('is defensive against a missing/malformed testResults field', () => {
    assert.deepEqual(selectNonPassedTestFiles({}), [])
    assert.deepEqual(selectNonPassedTestFiles(null), [])
  })
})

describe('classifyRerunExitCode', () => {
  it('classifies exit code 0 as FLAKY (passed standalone)', () => {
    assert.equal(classifyRerunExitCode(0), 'FLAKY')
  })

  it('classifies any non-zero exit code as REGRESSION (fails standalone too)', () => {
    assert.equal(classifyRerunExitCode(1), 'REGRESSION')
    assert.equal(classifyRerunExitCode(2), 'REGRESSION')
    assert.equal(classifyRerunExitCode(null), 'REGRESSION')
  })
})

describe('parseNearMissJsonl', () => {
  it('parses one JSON object per line', () => {
    const content = [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', testFilePath: '/repo/a.test.ts', attempt: 1, errnoOrClass: 'ETIMEDOUT', message: 'x' }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', testFilePath: '/repo/b.test.ts', attempt: 1, errnoOrClass: 'MongoNetworkError', message: 'y' }),
    ].join('\n')
    const { events, warnings } = parseNearMissJsonl(content)
    assert.equal(events.length, 2)
    assert.equal(warnings.length, 0)
    assert.equal(events[0].testFilePath, '/repo/a.test.ts')
    assert.equal(events[1].errnoOrClass, 'MongoNetworkError')
  })

  it('skips blank lines (including a trailing newline) without warning', () => {
    const content = `${JSON.stringify({ testFilePath: '/repo/a.test.ts' })}\n\n`
    const { events, warnings } = parseNearMissJsonl(content)
    assert.equal(events.length, 1)
    assert.equal(warnings.length, 0)
  })

  it('collects a warning (and skips the line) for invalid JSON instead of throwing', () => {
    const content = `${JSON.stringify({ testFilePath: '/repo/a.test.ts' })}\nnot json at all\n`
    const { events, warnings } = parseNearMissJsonl(content)
    assert.equal(events.length, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /not json at all/)
  })

  it('returns empty arrays for empty content', () => {
    assert.deepEqual(parseNearMissJsonl(''), { events: [], warnings: [] })
  })
})

describe('groupNearMissByFile', () => {
  it('groups events by testFilePath and counts them', () => {
    const events = [
      { testFilePath: '/repo/a.test.ts', attempt: 1 },
      { testFilePath: '/repo/b.test.ts', attempt: 1 },
      { testFilePath: '/repo/a.test.ts', attempt: 2 },
    ]
    const grouped = groupNearMissByFile(events)
    assert.equal(grouped.length, 2)
    const a = grouped.find((g) => g.testFilePath === '/repo/a.test.ts')
    const b = grouped.find((g) => g.testFilePath === '/repo/b.test.ts')
    assert.equal(a.count, 2)
    assert.equal(b.count, 1)
    assert.deepEqual(
      a.events.map((e) => e.attempt),
      [1, 2],
    )
  })

  it('falls back to a placeholder key for an event missing testFilePath', () => {
    const grouped = groupNearMissByFile([{ attempt: 1 }])
    assert.equal(grouped.length, 1)
    assert.equal(grouped[0].testFilePath, '(unknown file)')
  })

  it('returns an empty array for no events', () => {
    assert.deepEqual(groupNearMissByFile([]), [])
  })
})

describe('buildReport', () => {
  it('assembles the final structured report shape', () => {
    const report = buildReport({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      fullSuiteOutputFile: '/tmp/out.json',
      totalTestFiles: 140,
      failures: [{ file: '/repo/a.test.ts', classification: 'FLAKY', fullSuiteStatus: 'failed', firstFailureMessage: 'x', rerunExitCode: 0 }],
      nearMiss: [{ testFilePath: '/repo/b.test.ts', count: 1, events: [{ testFilePath: '/repo/b.test.ts' }] }],
    })
    assert.deepEqual(report, {
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      fullSuite: { outputFile: '/tmp/out.json', totalTestFiles: 140, nonPassedCount: 1 },
      failures: [{ file: '/repo/a.test.ts', classification: 'FLAKY', fullSuiteStatus: 'failed', firstFailureMessage: 'x', rerunExitCode: 0 }],
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
