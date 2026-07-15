// Unit tests for the pure classification/parsing/aggregation helpers in
// scripts/test-flake-taxonomy.mjs (feature-flake-failure-taxonomy AC-5). Run
// with `node --test` (see test-flake-report.test.mjs for the precedent).
// Only pure functions are covered here — `main()` spawns N real full-suite
// invocations, which isn't worth faking; `test-flake-report.mjs`'s untested
// `main()` is the same precedent.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { aggregateClasses, classifyRunRecords, classNameForRecord, generateRunId, parseChannelJsonl, resolveChannelPath } from './test-flake-taxonomy.mjs'

describe('generateRunId', () => {
  it('returns a distinct id on each call', () => {
    assert.notEqual(generateRunId(), generateRunId())
  })
})

describe('resolveChannelPath', () => {
  it('matches the `crowi-api-test-failure-taxonomy.<runId>.jsonl` formula failure-taxonomy-channel.js uses', () => {
    const runId = '12345-abc123-xyz'
    assert.ok(resolveChannelPath(runId).endsWith(`crowi-api-test-failure-taxonomy.${runId}.jsonl`))
  })
})

describe('parseChannelJsonl', () => {
  const runId = 'run-1'

  it('parses one JSON object per line', () => {
    const content = [
      JSON.stringify({ schemaVersion: 1, runId, kind: 'authoritative-file-result', testFilePath: '/repo/a.test.ts' }),
      JSON.stringify({ schemaVersion: 1, runId, kind: 'worker-enrichment', testFilePath: '/repo/a.test.ts' }),
    ].join('\n')
    const { records, warnings } = parseChannelJsonl(content, runId)
    assert.equal(records.length, 2)
    assert.equal(warnings.length, 0)
  })

  it('skips blank lines without warning', () => {
    const content = `${JSON.stringify({ schemaVersion: 1, runId, kind: 'authoritative-file-result' })}\n\n`
    const { records, warnings } = parseChannelJsonl(content, runId)
    assert.equal(records.length, 1)
    assert.equal(warnings.length, 0)
  })

  it('rejects invalid JSON with a warning instead of throwing', () => {
    const { records, warnings } = parseChannelJsonl('not json\n', runId)
    assert.equal(records.length, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /could not parse/)
  })

  it('rejects a row missing a recognizable "kind"', () => {
    const { records, warnings } = parseChannelJsonl(`${JSON.stringify({ schemaVersion: 1, runId })}\n`, runId)
    assert.equal(records.length, 0)
    assert.match(warnings[0], /no recognizable "kind"/)
  })

  it('rejects a row with an unrecognized schemaVersion', () => {
    const { records, warnings } = parseChannelJsonl(`${JSON.stringify({ schemaVersion: 999, runId, kind: 'authoritative-file-result' })}\n`, runId)
    assert.equal(records.length, 0)
    assert.match(warnings[0], /schemaVersion/)
  })

  it('rejects a foreign row (runId mismatch) — AC-4, N-run scoping', () => {
    const { records, warnings } = parseChannelJsonl(`${JSON.stringify({ schemaVersion: 1, runId: 'some-other-run', kind: 'authoritative-file-result' })}\n`, runId)
    assert.equal(records.length, 0)
    assert.match(warnings[0], /foreign/)
  })
})

describe('classNameForRecord', () => {
  it('names a worker-crash-by-signal class from workerCrash.kind/signal', () => {
    const record = { hasExecError: true, workerCrash: { kind: 'worker-terminated', signal: 'SIGSEGV', exitCode: null } }
    assert.equal(classNameForRecord(record, []), 'worker-crash:SIGSEGV')
  })

  it('names worker-crashed (no signal observable) distinctly', () => {
    const record = { hasExecError: true, workerCrash: { kind: 'worker-crashed', signal: null, exitCode: 1 } }
    assert.equal(classNameForRecord(record, []), 'worker-crash:unknown-exit')
  })

  it('names worker-oom distinctly', () => {
    const record = { hasExecError: true, workerCrash: { kind: 'worker-oom', signal: null, exitCode: null } }
    assert.equal(classNameForRecord(record, []), 'worker-crash:oom')
  })

  it('falls back to exec-error:unclassified when workerCrash carries no recognized kind', () => {
    const record = { hasExecError: true, workerCrash: { kind: 'exec-error', signal: null, exitCode: null } }
    assert.equal(classNameForRecord(record, []), 'exec-error:unclassified')
  })

  it('names pre-dispatch-timeout from a matching enrichment record — the Supertest ephemeral-port class', () => {
    const record = { hasExecError: false }
    const enrichment = [{ opContext: { operationKind: 'pre-dispatch', portClass: 'ephemeral', httpStatus: null } }]
    assert.equal(classNameForRecord(record, enrichment), 'pre-dispatch-timeout')
  })

  it('names mongo-op-failure for a unit-level failure whose portClass is mongo', () => {
    const record = { hasExecError: false }
    const enrichment = [{ opContext: { operationKind: 'unit', portClass: 'mongo', httpStatus: null } }]
    assert.equal(classNameForRecord(record, enrichment), 'mongo-op-failure')
  })

  it('names unit-failure for a unit-level failure with no portClass evidence', () => {
    const record = { hasExecError: false }
    const enrichment = [{ opContext: { operationKind: 'unit', portClass: null, httpStatus: null } }]
    assert.equal(classNameForRecord(record, enrichment), 'unit-failure')
  })

  it('names http-assertion-failure:<status> for an http operationKind with no expected/received pair in the message', () => {
    const record = { hasExecError: false, failureMessageExcerpt: 'expect(received).toBeDefined()' }
    const enrichment = [{ opContext: { operationKind: 'http', portClass: null, httpStatus: 404 } }]
    assert.equal(classNameForRecord(record, enrichment), 'http-assertion-failure:404')
  })

  it('names http-status-mismatch:expected-X-received-Y from the assertion message — the old JWT-timing-401 shape — instead of misattributing the ring buffer\'s last (unrelated) op status', () => {
    // Exactly the real shape observed in a multi-request test: the ring
    // buffer's last recorded op was a DIFFERENT, successful 200 request
    // (e.g. an earlier `POST /api/v2/pages` in the same test), but the
    // actual failing assertion checked a later request that got a 401.
    const record = {
      hasExecError: false,
      failureMessageExcerpt: 'expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 401',
    }
    const enrichment = [{ opContext: { operationKind: 'http', portClass: null, httpStatus: 200 } }]
    assert.equal(classNameForRecord(record, enrichment), 'http-status-mismatch:expected-200-received-401')
  })

  it('does not misfire the status-mismatch pattern on a non-HTTP-status toBe() failure (e.g. a plain count assertion) — falls back to the ring-buffer status', () => {
    const record = { hasExecError: false, failureMessageExcerpt: 'expect(received).toBe(expected)\n\nExpected: 5\nReceived: 3' }
    const enrichment = [{ opContext: { operationKind: 'http', portClass: null, httpStatus: 200 } }]
    // Both 5 and 3 are technically "plausible" 3-digit-or-fewer numbers but
    // NOT 3-digit HTTP status codes, so the pattern (which requires exactly
    // 3 digits on each side) never matches this message at all.
    assert.equal(classNameForRecord(record, enrichment), 'http-assertion-failure:200')
  })

  it('falls back to unclassified with no usable enrichment evidence', () => {
    assert.equal(classNameForRecord({ hasExecError: false }, []), 'unclassified')
  })

  it('falls back to unclassified when every matching enrichment record is itself unclassified', () => {
    const record = { hasExecError: false }
    const enrichment = [{ opContext: { operationKind: 'unclassified', portClass: 'other', httpStatus: null } }]
    assert.equal(classNameForRecord(record, enrichment), 'unclassified')
  })
})

describe('classifyRunRecords', () => {
  it('joins each authoritative record with its matching (by testFilePath) enrichment records', () => {
    const records = [
      { kind: 'authoritative-file-result', testFilePath: '/repo/a.test.ts', hasExecError: false },
      { kind: 'worker-enrichment', testFilePath: '/repo/a.test.ts', opContext: { operationKind: 'pre-dispatch', portClass: 'ephemeral', httpStatus: null } },
      { kind: 'worker-enrichment', testFilePath: '/repo/OTHER.test.ts', opContext: { operationKind: 'http', portClass: null, httpStatus: 500 } },
    ]
    const classified = classifyRunRecords(records)
    assert.equal(classified.length, 1)
    assert.equal(classified[0].className, 'pre-dispatch-timeout')
    assert.equal(classified[0].matchingEnrichment.length, 1)
  })

  it('returns an empty array when there are no authoritative records', () => {
    assert.deepEqual(classifyRunRecords([{ kind: 'worker-enrichment', testFilePath: '/repo/a.test.ts' }]), [])
  })
})

describe('aggregateClasses', () => {
  it('counts occurrences across runs and keeps the FIRST repro example per class', () => {
    const runs = [
      { runId: 'run-1', mode: 'standalone', classifiedRecords: [{ className: 'worker-crash:SIGSEGV', testFilePath: '/repo/a.test.ts' }] },
      { runId: 'run-2', mode: 'standalone', classifiedRecords: [{ className: 'worker-crash:SIGSEGV', testFilePath: '/repo/b.test.ts' }] },
      { runId: 'run-3', mode: 'turbo', classifiedRecords: [{ className: 'pre-dispatch-timeout', testFilePath: '/repo/c.test.ts' }] },
    ]
    const { counts, repro } = aggregateClasses(runs)
    assert.deepEqual(counts, { 'worker-crash:SIGSEGV': 2, 'pre-dispatch-timeout': 1 })
    assert.equal(repro['worker-crash:SIGSEGV'].runId, 'run-1')
    assert.equal(repro['worker-crash:SIGSEGV'].testFilePath, '/repo/a.test.ts')
    assert.equal(repro['pre-dispatch-timeout'].runId, 'run-3')
  })

  it('returns empty counts/repro for zero runs (or runs with zero failures) — the unclassified bucket only appears when it was actually observed', () => {
    assert.deepEqual(aggregateClasses([]), { counts: {}, repro: {} })
    assert.deepEqual(aggregateClasses([{ runId: 'run-1', mode: 'standalone', classifiedRecords: [] }]), { counts: {}, repro: {} })
  })
})
