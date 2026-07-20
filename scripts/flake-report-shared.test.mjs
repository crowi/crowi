// Unit tests for scripts/flake-report-shared.mjs (feature-flake-report-detection-redesign).
// Run with `node --test` (see dev-ports.test.mjs for the rationale).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  classifyRerunOutcome,
  generateRunId,
  groupNearMissByFile,
  matchInfrastructureStderr,
  parseManifestJson,
  parseNearMissJsonl,
  resolveApiJestOutputPath,
  resolveClassificationReportPath,
  resolveManifestPath,
  resolveNearMissEventsPath,
  selectNonPassedTestFiles,
  truncateForArtifact,
  verifyManifestPaths,
  verifyManifestRunId,
} from './flake-report-shared.mjs'

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

describe('path formulas', () => {
  it('resolveNearMissEventsPath matches the `crowi-api-test-retry-events.<runId>.jsonl` formula db-connect-retry.ts uses', () => {
    assert.ok(resolveNearMissEventsPath('12345-abc123').endsWith('crowi-api-test-retry-events.12345-abc123.jsonl'))
  })

  it('resolveApiJestOutputPath is deterministic and run-scoped', () => {
    assert.ok(resolveApiJestOutputPath('12345-abc123').endsWith('crowi-api-test-result.12345-abc123.json'))
  })

  it('resolveManifestPath is deterministic and run-scoped', () => {
    assert.ok(resolveManifestPath('12345-abc123').endsWith('crowi-flake-report-manifest.12345-abc123.json'))
  })

  it('resolveClassificationReportPath is deterministic and run-scoped', () => {
    assert.ok(resolveClassificationReportPath('12345-abc123').endsWith('crowi-flake-report-classification.12345-abc123.json'))
  })

  it('every path formula is unique per runId (no accidental collisions between the four)', () => {
    const runId = '12345-abc123'
    const paths = new Set([resolveNearMissEventsPath(runId), resolveApiJestOutputPath(runId), resolveManifestPath(runId), resolveClassificationReportPath(runId)])
    assert.equal(paths.size, 4)
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

describe('matchInfrastructureStderr', () => {
  it('recognizes a worker-terminated-by-signal message', () => {
    const reason = matchInfrastructureStderr('A jest worker process (pid=123) was terminated by another process: signal=SIGSEGV, exitCode=null.')
    assert.match(reason, /terminated by a signal/)
  })

  it('recognizes a worker-crashed-for-unknown-reason message', () => {
    const reason = matchInfrastructureStderr('A jest worker process (pid=123) crashed for an unknown reason: exitCode=134.')
    assert.match(reason, /crashed for an unknown reason/)
  })

  it('recognizes a worker-out-of-memory message', () => {
    const reason = matchInfrastructureStderr('Jest worker ran out of memory and crashed')
    assert.match(reason, /out of memory/)
  })

  it('recognizes a DB connect failure message', () => {
    const reason = matchInfrastructureStderr('Cannot connect to Database Server: connect ETIMEDOUT 127.0.0.1:27018')
    assert.match(reason, /could not connect to the test database/)
  })

  it('recognizes global-teardown.js rejecting a solo rerun for missing full-suite-only Redis smoke coverage', () => {
    // The exact message shape `CI=true pnpm --filter @crowi/api test
    // --runTestsByPath <file>` produces locally when the target file isn't
    // one of the 8 Redis smoke suites — this fires for essentially every
    // solo rerun, which is exactly the false-REGRESSION bug this pattern
    // exists to close.
    const reason = matchInfrastructureStderr(
      'Error: Jest: Got error running globalTeardown - /repo/packages/api/src/test/global-teardown.js, reason: ' +
        '[test] Redis smoke categories missing in CI (ran 0/8): collab, editor-cap, presence, notifications, config, rate-limit, lru, boot — ' +
        'each category records a marker in its own `beforeAll` (proof the describe block was not skipped); a missing marker means that smoke ' +
        'suite never ran even though CI (per feature-redis-8-upgrade Phase 1) guarantees the underlying Redis instances are reachable.',
    )
    assert.match(reason, /missing full-suite-only Redis smoke category coverage/)
  })

  it('returns null for an ordinary assertion failure (must never invent a false positive)', () => {
    assert.equal(matchInfrastructureStderr('Expected: 200\nReceived: 401'), null)
  })

  it('is defensive against non-string / empty input', () => {
    assert.equal(matchInfrastructureStderr(null), null)
    assert.equal(matchInfrastructureStderr(undefined), null)
    assert.equal(matchInfrastructureStderr(''), null)
  })
})

describe('classifyRerunOutcome', () => {
  it('classifies exit code 0 as FLAKY (passed standalone)', () => {
    assert.deepEqual(classifyRerunOutcome({ status: 0, signal: null, error: null, stderr: '' }), { classification: 'FLAKY', reason: null })
  })

  it('classifies a non-zero exit with no infra signature as REGRESSION (fails standalone too)', () => {
    const result = classifyRerunOutcome({ status: 1, signal: null, error: null, stderr: 'Expected: 200\nReceived: 401' })
    assert.equal(result.classification, 'REGRESSION')
    assert.equal(result.reason, null)
  })

  it('classifies a spawn launch failure (e.g. missing binary) as INCONCLUSIVE', () => {
    const result = classifyRerunOutcome({ status: null, signal: null, error: new Error('spawn pnpm ENOENT'), stderr: '' })
    assert.equal(result.classification, 'INCONCLUSIVE')
    assert.match(result.reason, /failed to launch/)
  })

  it('classifies a spawnSync timeout (error.code === ETIMEDOUT) as INCONCLUSIVE with a timeout-specific reason, not "failed to launch"', () => {
    const timeoutError = new Error('spawnSync pnpm ETIMEDOUT')
    timeoutError.code = 'ETIMEDOUT'
    const result = classifyRerunOutcome({ status: null, signal: 'SIGTERM', error: timeoutError, stderr: '' })
    assert.equal(result.classification, 'INCONCLUSIVE')
    assert.match(result.reason, /exceeded its timeout/)
    assert.doesNotMatch(result.reason, /failed to launch/)
  })

  it('classifies a signal-terminated process as INCONCLUSIVE', () => {
    const result = classifyRerunOutcome({ status: null, signal: 'SIGSEGV', error: null, stderr: '' })
    assert.equal(result.classification, 'INCONCLUSIVE')
    assert.match(result.reason, /signal SIGSEGV/)
  })

  it('classifies a null status with no signal as INCONCLUSIVE (spawnSync ambiguous outcome)', () => {
    const result = classifyRerunOutcome({ status: null, signal: null, error: null, stderr: '' })
    assert.equal(result.classification, 'INCONCLUSIVE')
    assert.match(result.reason, /null status/)
  })

  it('classifies a non-zero exit whose stderr matches a worker-crash signature as INCONCLUSIVE, not REGRESSION', () => {
    const result = classifyRerunOutcome({
      status: 1,
      signal: null,
      error: null,
      stderr: 'A jest worker process (pid=456) was terminated by another process: signal=SIGSEGV, exitCode=null.',
    })
    assert.equal(result.classification, 'INCONCLUSIVE')
  })

  it('classifies a non-zero exit whose stderr matches a DB connect failure as INCONCLUSIVE, not REGRESSION', () => {
    const result = classifyRerunOutcome({ status: 1, signal: null, error: null, stderr: 'Cannot connect to Database Server: connect ECONNREFUSED' })
    assert.equal(result.classification, 'INCONCLUSIVE')
  })

  it('classifies a non-zero exit whose stderr matches the Redis-smoke-coverage globalTeardown rejection as INCONCLUSIVE, not REGRESSION', () => {
    // Without this, every solo rerun of a non-smoke file was misclassified
    // REGRESSION regardless of whether the target test actually passed.
    const result = classifyRerunOutcome({
      status: 1,
      signal: null,
      error: null,
      stderr: 'Error: Jest: Got error running globalTeardown - .../global-teardown.js, reason: [test] Redis smoke categories missing in CI (ran 0/8): boot',
    })
    assert.equal(result.classification, 'INCONCLUSIVE')
  })
})

describe('manifest', () => {
  it('buildManifest assembles the expected shape', () => {
    const manifest = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: '/tmp/crowi-api-test-result.123-abc.json',
      apiJestOutputFileWritten: true,
      nearMissEventsFile: '/tmp/crowi-api-test-retry-events.123-abc.jsonl',
      nearMissEventsFileWritten: false,
    })
    assert.deepEqual(manifest, {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      producer: { job: 'test', workflowRunId: '999', workflowRunAttempt: '1' },
      apiJest: { outputFile: '/tmp/crowi-api-test-result.123-abc.json', outputFileWritten: true },
      nearMiss: { eventsFile: '/tmp/crowi-api-test-retry-events.123-abc.jsonl', eventsFileWritten: false },
    })
  })

  it('parseManifestJson round-trips a manifest built by buildManifest', () => {
    const built = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: null,
      workflowRunAttempt: null,
      apiJestOutputFile: '/tmp/x.json',
      apiJestOutputFileWritten: false,
      nearMissEventsFile: '/tmp/y.jsonl',
      nearMissEventsFileWritten: false,
    })
    const { manifest, error } = parseManifestJson(JSON.stringify(built))
    assert.equal(error, null)
    assert.deepEqual(manifest, built)
  })

  it('parseManifestJson rejects invalid JSON instead of throwing', () => {
    const { manifest, error } = parseManifestJson('not json at all')
    assert.equal(manifest, null)
    assert.match(error, /not valid JSON/)
  })

  it('parseManifestJson rejects empty content', () => {
    const { manifest, error } = parseManifestJson('')
    assert.equal(manifest, null)
    assert.match(error, /empty/)
  })

  it('parseManifestJson rejects a JSON object missing a string runId', () => {
    const { manifest, error } = parseManifestJson(JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION }))
    assert.equal(manifest, null)
    assert.match(error, /missing a string runId/)
  })

  it('parseManifestJson rejects an unrecognized schemaVersion', () => {
    const { manifest, error } = parseManifestJson(JSON.stringify({ schemaVersion: 999, runId: '123-abc' }))
    assert.equal(manifest, null)
    assert.match(error, /schemaVersion/)
  })

  it('verifyManifestRunId accepts a matching runId', () => {
    assert.deepEqual(verifyManifestRunId({ runId: '123-abc' }, '123-abc'), { ok: true, reason: null })
  })

  it('verifyManifestRunId rejects a mismatched runId (a foreign/stale manifest)', () => {
    const result = verifyManifestRunId({ runId: '123-abc' }, '999-xyz')
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not match/)
  })

  it('verifyManifestRunId rejects a null manifest', () => {
    const result = verifyManifestRunId(null, '123-abc')
    assert.equal(result.ok, false)
  })

  it('verifyManifestPaths accepts a manifest whose apiJest/nearMiss paths match the deterministic formulas for the runId', () => {
    const manifest = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: resolveApiJestOutputPath('123-abc'),
      apiJestOutputFileWritten: true,
      nearMissEventsFile: resolveNearMissEventsPath('123-abc'),
      nearMissEventsFileWritten: false,
    })
    assert.deepEqual(verifyManifestPaths(manifest, '123-abc'), { ok: true, reason: null })
  })

  it('verifyManifestPaths rejects a manifest whose apiJest.outputFile does not match the runId (a same-run manifest pointing at an unrelated file)', () => {
    const manifest = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: '/tmp/some-unrelated-file.json',
      apiJestOutputFileWritten: true,
      nearMissEventsFile: resolveNearMissEventsPath('123-abc'),
      nearMissEventsFileWritten: false,
    })
    const result = verifyManifestPaths(manifest, '123-abc')
    assert.equal(result.ok, false)
    assert.match(result.reason, /apiJest\.outputFile/)
  })

  it('verifyManifestPaths rejects a manifest whose nearMiss.eventsFile does not match the runId', () => {
    const manifest = buildManifest({
      runId: '123-abc',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflowRunId: '999',
      workflowRunAttempt: '1',
      apiJestOutputFile: resolveApiJestOutputPath('123-abc'),
      apiJestOutputFileWritten: true,
      nearMissEventsFile: '/tmp/some-unrelated-events.jsonl',
      nearMissEventsFileWritten: true,
    })
    const result = verifyManifestPaths(manifest, '123-abc')
    assert.equal(result.ok, false)
    assert.match(result.reason, /nearMiss\.eventsFile/)
  })
})

describe('truncateForArtifact', () => {
  it('returns the original string unchanged when under the max length', () => {
    assert.equal(truncateForArtifact('short stderr', 100), 'short stderr')
  })

  it('truncates and annotates a string over the max length', () => {
    const text = 'x'.repeat(150)
    const result = truncateForArtifact(text, 100)
    assert.equal(result.length < text.length, true)
    assert.match(result, /truncated, 150 bytes total/)
  })

  it('returns null for empty/non-string input instead of throwing', () => {
    assert.equal(truncateForArtifact(''), null)
    assert.equal(truncateForArtifact(null), null)
    assert.equal(truncateForArtifact(undefined), null)
  })

  it('uses a generous default max length suitable for a full jest failure report', () => {
    const text = 'x'.repeat(15_000)
    assert.equal(truncateForArtifact(text), text)
  })
})
