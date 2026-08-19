import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { appendRecord, buildRecord } from './record-run-metrics.mjs'

const CLI = fileURLToPath(new URL('./record-run-metrics.mjs', import.meta.url))

test('buildRecord stamps schemaVersion + recordedAt without clobbering the payload', () => {
  const fixed = new Date('2026-01-02T03:04:05.000Z')
  const rec = buildRecord({ workflow: 'crowi-feature-pipeline', status: 'DONE' }, { now: () => fixed })
  assert.equal(rec.schemaVersion, 1)
  assert.equal(rec.recordedAt, '2026-01-02T03:04:05.000Z')
  assert.equal(rec.workflow, 'crowi-feature-pipeline')
  assert.equal(rec.status, 'DONE')
})

test('buildRecord rejects non-object metrics', () => {
  assert.throws(() => buildRecord(null))
  assert.throws(() => buildRecord([1]))
  assert.throws(() => buildRecord('x'))
})

test('appendRecord creates the directory and appends one JSON line per call', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crowi-metrics-'))
  try {
    const nested = path.join(dir, 'a', 'b')
    appendRecord(nested, 'metrics.jsonl', { n: 1 })
    appendRecord(nested, 'metrics.jsonl', { n: 2 })
    const lines = readFileSync(path.join(nested, 'metrics.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).n, 1)
    assert.equal(JSON.parse(lines[1]).n, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: --data appends a stamped line and reports the path; bad JSON exits 1; missing --dir exits 2', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crowi-metrics-cli-'))
  try {
    const out = execFileSync(process.execPath, [CLI, '--dir', dir, '--data', '{"status":"DONE","phases":2}'])
    const reply = JSON.parse(out.toString('utf8'))
    assert.equal(reply.wrote, true)
    const line = JSON.parse(readFileSync(reply.path, 'utf8').trim())
    assert.equal(line.status, 'DONE')
    assert.equal(line.phases, 2)
    assert.ok(line.recordedAt)
    assert.throws(() => execFileSync(process.execPath, [CLI, '--dir', dir, '--data', 'not-json'], { stdio: 'pipe' }))
    assert.throws(() => execFileSync(process.execPath, [CLI, '--data', '{}'], { stdio: 'pipe' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
