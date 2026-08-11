// Unit tests for the pure CLI/watch-set helpers in `scripts/dev.mjs`.
// The impure launcher (`main()`) is guarded by `import.meta.main`, so importing
// the module here never spawns turbo.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeDevFilters, parseDevCliArgs, resolveWatchTargets } from './dev.mjs'

test('parseDevCliArgs: defaults to an empty watch list', () => {
  assert.deepEqual(parseDevCliArgs([]), { anchor: undefined, isolateDb: false, watch: [] })
})

test('parseDevCliArgs: collects repeated --watch values verbatim', () => {
  const cli = parseDevCliArgs(['--watch', 'plugin-slack', '--watch', '@crowi/api-contract'])
  assert.deepEqual(cli.watch, ['plugin-slack', '@crowi/api-contract'])
})

test('parseDevCliArgs: --watch coexists with --anchor and --isolate-db', () => {
  const cli = parseDevCliArgs(['--anchor', '7', '--watch', 'collab', '--isolate-db'])
  assert.equal(cli.anchor, 7)
  assert.equal(cli.isolateDb, true)
  assert.deepEqual(cli.watch, ['collab'])
})

test('parseDevCliArgs: --watch with a missing value throws', () => {
  assert.throws(() => parseDevCliArgs(['--watch']), /--watch requires a package name/)
})

test('parseDevCliArgs: --watch swallowing the next flag throws', () => {
  assert.throws(() => parseDevCliArgs(['--watch', '--isolate-db']), /--watch requires a package name/)
})

const KNOWN = ['@crowi/api', '@crowi/web', '@crowi/api-contract', '@crowi/collab', '@crowi/runner', '@crowi/plugin-slack']

test('resolveWatchTargets: accepts short names and maps them to full names', () => {
  assert.deepEqual(resolveWatchTargets(['plugin-slack', 'collab'], KNOWN), ['@crowi/plugin-slack', '@crowi/collab'])
})

test('resolveWatchTargets: accepts full names unchanged', () => {
  assert.deepEqual(resolveWatchTargets(['@crowi/api-contract'], KNOWN), ['@crowi/api-contract'])
})

test('resolveWatchTargets: dedupes while preserving first-seen order', () => {
  assert.deepEqual(resolveWatchTargets(['collab', '@crowi/collab', 'plugin-slack'], KNOWN), ['@crowi/collab', '@crowi/plugin-slack'])
})

test('resolveWatchTargets: rejects an unknown package', () => {
  assert.throws(() => resolveWatchTargets(['nope'], KNOWN), /unknown package "nope"/)
})

test('computeDevFilters: always includes api/web/api-contract even with no watch targets', () => {
  assert.deepEqual(computeDevFilters([]), ['@crowi/api', '@crowi/web', '@crowi/api-contract'])
})

test('computeDevFilters: appends extra watch targets without duplicating the always-watched set', () => {
  assert.deepEqual(computeDevFilters(['@crowi/api-contract', '@crowi/plugin-slack']), [
    '@crowi/api',
    '@crowi/web',
    '@crowi/api-contract',
    '@crowi/plugin-slack',
  ])
})
