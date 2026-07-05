// Unit tests for the destructive-migration guard in scripts/migrate.mjs
// (feature-dev-portal-worktree §3 data-protection backstop). Run with
// `node --test` (see dev-ports.test.mjs for the rationale). Only the pure
// decision functions are covered here — the wrapper's `main()` shells out to
// the built admin-cli and reads the real repo's worktree key, which isn't
// worth faking; `scripts/dev.mjs` follows the same untested-glue precedent.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isDestructiveMigrateCommand, isMigrationGuardBypassed, isNonMainSharedDb } from './migrate.mjs'

describe('isDestructiveMigrateCommand', () => {
  it('is true for a bare apply', () => {
    assert.equal(isDestructiveMigrateCommand(['apply']), true)
  })

  it('is false for apply --dry-run', () => {
    assert.equal(isDestructiveMigrateCommand(['apply', '--dry-run']), false)
  })

  it('is false for plan/status/list', () => {
    assert.equal(isDestructiveMigrateCommand(['plan']), false)
    assert.equal(isDestructiveMigrateCommand(['status']), false)
    assert.equal(isDestructiveMigrateCommand(['list']), false)
  })

  it('is true for apply with other flags, as long as --dry-run is absent', () => {
    assert.equal(isDestructiveMigrateCommand(['apply', '--all-layers', '--id', 'foo']), true)
  })
})

describe('isMigrationGuardBypassed', () => {
  it('is true when --yes is present', () => {
    assert.equal(isMigrationGuardBypassed(['apply', '--yes'], {}), true)
  })

  it('is true when CROWI_MIGRATE_FORCE=1 is set', () => {
    assert.equal(isMigrationGuardBypassed(['apply'], { CROWI_MIGRATE_FORCE: '1' }), true)
  })

  it('is false otherwise', () => {
    assert.equal(isMigrationGuardBypassed(['apply'], {}), false)
    assert.equal(isMigrationGuardBypassed(['apply'], { CROWI_MIGRATE_FORCE: '0' }), false)
  })
})

describe('isNonMainSharedDb', () => {
  it('is false for the main worktree regardless of isolation', () => {
    assert.equal(isNonMainSharedDb({ key: 'main', isolateDb: false }), false)
    assert.equal(isNonMainSharedDb({ key: 'main', isolateDb: true }), false)
  })

  it('is false for a non-main worktree that opted into DB isolation', () => {
    assert.equal(isNonMainSharedDb({ key: 'feature-x', isolateDb: true }), false)
  })

  it('is true for a non-main worktree on the shared DB', () => {
    assert.equal(isNonMainSharedDb({ key: 'feature-x', isolateDb: false }), true)
  })
})
