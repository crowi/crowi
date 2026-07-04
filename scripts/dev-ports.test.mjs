// Unit tests for scripts/dev-ports.mjs. Run with `node --test` (built-in
// runner, matches `packages/api-contract/src/util/html-elements.test.ts`) —
// no dev dependency needed, per the zero-dep constraint for root `scripts/`.
//
// Registry/lock tests use a temp dir per test (never the real
// `~/.crowi-dev-ports.json`), and the OS port probe is stubbed out (`isRangeFree`
// is always injected) so the suite never binds a real socket or depends on the
// host's actual port availability.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  acquireLock,
  allocateAnchor,
  buildAllowedDevOrigins,
  isolatedDbName,
  MAIN_ANCHOR,
  normalizeWorktreeKey,
  parseTailscaleHostname,
  pickNextAnchor,
  portsForAnchor,
  pruneRegistry,
  readDevLocalConfig,
  readEnvFileValue,
  readRegistry,
  resolveBaseMongoUri,
  withMongoDbName,
  writeRegistry,
} from './dev-ports.mjs'

let tmpDir

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowi-dev-ports-test-'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function tmpPaths(name) {
  return {
    registryPath: path.join(tmpDir, `${name}.registry.json`),
    lockPath: path.join(tmpDir, `${name}.lock`),
  }
}

const alwaysFree = async () => true

describe('normalizeWorktreeKey', () => {
  it('strips the crowi- prefix from a feature worktree dir', () => {
    assert.equal(normalizeWorktreeKey('/Volumes/working/crowi/crowi-feature-foo'), 'feature-foo')
  })

  it('maps the bare "crowi" checkout to "main"', () => {
    assert.equal(normalizeWorktreeKey('/Volumes/working/crowi/crowi'), 'main')
  })

  it('passes through a dir with no crowi- prefix unchanged', () => {
    assert.equal(normalizeWorktreeKey('/tmp/some-other-checkout'), 'some-other-checkout')
  })
})

describe('portsForAnchor', () => {
  it('lays out api/web/site/proxy at anchor..anchor+3', () => {
    assert.deepEqual(portsForAnchor(4310), { api: 4310, web: 4311, site: 4312, proxy: 4313 })
  })
})

describe('registry read/write', () => {
  it('returns {} when the file does not exist', () => {
    const { registryPath } = tmpPaths('missing')
    assert.deepEqual(readRegistry(registryPath), {})
  })

  it('round-trips through writeRegistry/readRegistry, sorted', () => {
    const { registryPath } = tmpPaths('roundtrip')
    writeRegistry({ b: 4320, a: 4310 }, registryPath)
    assert.deepEqual(readRegistry(registryPath), { a: 4310, b: 4320 })
    // sorted keys in the persisted file (stable diffs when eyeballed)
    assert.equal(fs.readFileSync(registryPath, 'utf8'), '{\n  "a": 4310,\n  "b": 4320\n}\n')
  })

  it('recovers from a corrupt registry file instead of throwing', () => {
    const { registryPath } = tmpPaths('corrupt')
    fs.writeFileSync(registryPath, 'not json{{{')
    assert.deepEqual(readRegistry(registryPath), {})
  })
})

describe('pickNextAnchor', () => {
  it('returns the start anchor when nothing is used and the range is free', async () => {
    const anchor = await pickNextAnchor({ used: new Set(), isRangeFree: alwaysFree })
    assert.equal(anchor, 4310)
  })

  it('skips anchors already present in `used`', async () => {
    const anchor = await pickNextAnchor({ used: new Set([4310, 4320]), isRangeFree: alwaysFree })
    assert.equal(anchor, 4330)
  })

  it('skips anchors whose OS ports are not free even if unused in the registry', async () => {
    const isRangeFree = async (anchor) => anchor !== 4310
    const anchor = await pickNextAnchor({ used: new Set(), isRangeFree })
    assert.equal(anchor, 4320)
  })
})

describe('acquireLock', () => {
  it('serializes two acquisitions on the same lockfile', async () => {
    const { lockPath } = tmpPaths('lock-serial')
    const release1 = await acquireLock(lockPath, { retries: 5, retryDelayMs: 10 })
    assert.ok(fs.existsSync(lockPath))

    let secondAcquired = false
    const secondPromise = acquireLock(lockPath, { retries: 20, retryDelayMs: 10 }).then((release2) => {
      secondAcquired = true
      release2()
    })

    // Give the retry loop a couple of ticks — it must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(secondAcquired, false, 'second acquisition must not succeed while the first holds the lock')

    release1()
    await secondPromise
    assert.equal(secondAcquired, true)
  })

  it('steals a stale lock older than staleMs', async () => {
    const { lockPath } = tmpPaths('lock-stale')
    fs.writeFileSync(lockPath, '999999') // simulate a crashed holder's leftover lockfile
    const oldTime = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, oldTime, oldTime)

    const release = await acquireLock(lockPath, { retries: 5, retryDelayMs: 10, staleMs: 5000 })
    assert.ok(fs.existsSync(lockPath))
    release()
    assert.ok(!fs.existsSync(lockPath))
  })
})

describe('allocateAnchor', () => {
  it('main always resolves to 4301 regardless of registry contents', async () => {
    const { registryPath, lockPath } = tmpPaths('main')
    const { anchor, source } = await allocateAnchor({ key: 'main', registryPath, lockPath, isRangeFree: alwaysFree })
    assert.equal(anchor, MAIN_ANCHOR)
    assert.equal(source, 'main')
  })

  it('auto-picks the next free anchor for a new key and persists it', async () => {
    const { registryPath, lockPath } = tmpPaths('auto')
    const first = await allocateAnchor({ key: 'feature-a', registryPath, lockPath, isRangeFree: alwaysFree })
    assert.equal(first.anchor, 4310)
    assert.equal(first.source, 'auto')

    const second = await allocateAnchor({ key: 'feature-b', registryPath, lockPath, isRangeFree: alwaysFree })
    assert.equal(second.anchor, 4320)
    assert.deepEqual(readRegistry(registryPath), { 'feature-a': 4310, 'feature-b': 4320 })
  })

  it('reuses the existing anchor for the same key on a re-run', async () => {
    const { registryPath, lockPath } = tmpPaths('reuse')
    const first = await allocateAnchor({ key: 'feature-c', registryPath, lockPath, isRangeFree: alwaysFree })
    const second = await allocateAnchor({ key: 'feature-c', registryPath, lockPath, isRangeFree: alwaysFree })
    assert.equal(second.anchor, first.anchor)
    assert.equal(second.source, 'existing')
  })

  it('an explicit anchor pins and persists regardless of an existing entry', async () => {
    const { registryPath, lockPath } = tmpPaths('explicit')
    await allocateAnchor({ key: 'feature-d', registryPath, lockPath, isRangeFree: alwaysFree })
    const pinned = await allocateAnchor({ key: 'feature-d', explicitAnchor: 4350, registryPath, lockPath, isRangeFree: alwaysFree })
    assert.equal(pinned.anchor, 4350)
    assert.equal(pinned.source, 'explicit')
    assert.deepEqual(readRegistry(registryPath), { 'feature-d': 4350 })
  })

  it('rejects a non-positive-integer explicit anchor', async () => {
    const { registryPath, lockPath } = tmpPaths('invalid')
    await assert.rejects(
      allocateAnchor({ key: 'feature-e', explicitAnchor: -1, registryPath, lockPath, isRangeFree: alwaysFree }),
      /positive integer/,
    )
  })

  it('does not double-allocate under concurrent calls for different keys (race)', async () => {
    const { registryPath, lockPath } = tmpPaths('race')
    const keys = ['w1', 'w2', 'w3', 'w4', 'w5']
    const results = await Promise.all(keys.map((key) => allocateAnchor({ key, registryPath, lockPath, isRangeFree: alwaysFree })))
    const anchors = results.map((r) => r.anchor)
    assert.equal(new Set(anchors).size, anchors.length, 'every concurrently-allocated key must get a distinct anchor')
    assert.deepEqual(
      readRegistry(registryPath),
      Object.fromEntries(keys.map((key, i) => [key, anchors[i]])),
    )
  })

  it('concurrent calls for the SAME key converge on one anchor, not two', async () => {
    const { registryPath, lockPath } = tmpPaths('race-same-key')
    const [a, b] = await Promise.all([
      allocateAnchor({ key: 'shared-key', registryPath, lockPath, isRangeFree: alwaysFree }),
      allocateAnchor({ key: 'shared-key', registryPath, lockPath, isRangeFree: alwaysFree }),
    ])
    assert.equal(a.anchor, b.anchor)
    assert.deepEqual(readRegistry(registryPath), { 'shared-key': a.anchor })
  })
})

describe('pruneRegistry', () => {
  it('drops keys with no matching live worktree', () => {
    const registry = { main: 4301, 'feature-a': 4310, 'feature-gone': 4320 }
    assert.deepEqual(pruneRegistry(registry, ['main', 'feature-a']), { main: 4301, 'feature-a': 4310 })
  })

  it('keeps everything when all keys are live', () => {
    const registry = { main: 4301, 'feature-a': 4310 }
    assert.deepEqual(pruneRegistry(registry, ['main', 'feature-a']), registry)
  })

  it('returns {} when nothing is live', () => {
    assert.deepEqual(pruneRegistry({ main: 4301 }, []), {})
  })
})

describe('readDevLocalConfig', () => {
  it('defaults to not-isolated when dev.local.json is missing', () => {
    assert.deepEqual(readDevLocalConfig(tmpDir), { isolateDb: false })
  })

  it('reads isolateDb: true', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'wt-'))
    fs.writeFileSync(path.join(dir, 'dev.local.json'), JSON.stringify({ isolateDb: true }))
    assert.deepEqual(readDevLocalConfig(dir), { isolateDb: true })
  })

  it('is tolerant of malformed JSON (fails safe to shared DB)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'wt-'))
    fs.writeFileSync(path.join(dir, 'dev.local.json'), '{not valid')
    assert.deepEqual(readDevLocalConfig(dir), { isolateDb: false })
  })
})

describe('withMongoDbName / isolatedDbName', () => {
  it('rewrites a simple host/db URI', () => {
    assert.equal(withMongoDbName('mongodb://localhost/crowi', 'crowi_feature-x'), 'mongodb://localhost/crowi_feature-x')
  })

  it('preserves host:port and query string', () => {
    assert.equal(
      withMongoDbName('mongodb://127.0.0.1:27017/crowi_dev2?retryWrites=true', 'crowi_feature-x'),
      'mongodb://127.0.0.1:27017/crowi_feature-x?retryWrites=true',
    )
  })

  it('handles a URI with no db path segment', () => {
    assert.equal(withMongoDbName('mongodb://localhost:27017', 'crowi_feature-x'), 'mongodb://localhost:27017/crowi_feature-x')
  })

  it('isolatedDbName prefixes the key', () => {
    assert.equal(isolatedDbName('feature-x'), 'crowi_feature-x')
  })
})

describe('readEnvFileValue', () => {
  it('reads a plain KEY=value line', () => {
    const file = path.join(tmpDir, 'plain.env')
    fs.writeFileSync(file, 'MONGO_URI=mongodb://localhost/crowi\nOTHER=1\n')
    assert.equal(readEnvFileValue(file, 'MONGO_URI'), 'mongodb://localhost/crowi')
  })

  it('strips matching quotes and ignores comments/blank lines', () => {
    const file = path.join(tmpDir, 'quoted.env')
    fs.writeFileSync(file, '# comment\n\nMONGO_URI="mongodb://localhost/crowi"\n')
    assert.equal(readEnvFileValue(file, 'MONGO_URI'), 'mongodb://localhost/crowi')
  })

  it('returns undefined for a missing file or missing key', () => {
    assert.equal(readEnvFileValue(path.join(tmpDir, 'does-not-exist.env'), 'MONGO_URI'), undefined)
    const file = path.join(tmpDir, 'noval.env')
    fs.writeFileSync(file, 'OTHER=1\n')
    assert.equal(readEnvFileValue(file, 'MONGO_URI'), undefined)
  })
})

describe('resolveBaseMongoUri', () => {
  const originalMongoUri = process.env.MONGO_URI

  after(() => {
    if (originalMongoUri === undefined) delete process.env.MONGO_URI
    else process.env.MONGO_URI = originalMongoUri
  })

  it('prefers an explicit MONGO_URI env var over the .env file', () => {
    const file = path.join(tmpDir, 'base-explicit.env')
    fs.writeFileSync(file, 'MONGO_URI=mongodb://from-file/crowi\n')
    process.env.MONGO_URI = 'mongodb://from-env/crowi'
    assert.equal(resolveBaseMongoUri(file), 'mongodb://from-env/crowi')
  })

  it('falls back to the .env file when MONGO_URI is unset', () => {
    delete process.env.MONGO_URI
    const file = path.join(tmpDir, 'base-fallback.env')
    fs.writeFileSync(file, 'MONGO_URI=mongodb://from-file/crowi\n')
    assert.equal(resolveBaseMongoUri(file), 'mongodb://from-file/crowi')
  })

  it('falls back to the local default when nothing is configured', () => {
    delete process.env.MONGO_URI
    assert.equal(resolveBaseMongoUri(path.join(tmpDir, 'does-not-exist.env')), 'mongodb://localhost:27017/crowi')
  })
})

describe('buildAllowedDevOrigins', () => {
  it('always includes localhost/127.0.0.1 even with no tailscale host', () => {
    assert.equal(buildAllowedDevOrigins({ tailscaleHost: null }), 'localhost,127.0.0.1')
  })

  it('appends the tailscale hostname when present', () => {
    assert.equal(buildAllowedDevOrigins({ tailscaleHost: 'my-mac.tailnet.ts.net' }), 'localhost,127.0.0.1,my-mac.tailnet.ts.net')
  })

  it('de-duplicates', () => {
    assert.equal(buildAllowedDevOrigins({ tailscaleHost: 'localhost' }), 'localhost,127.0.0.1')
  })
})

describe('parseTailscaleHostname', () => {
  it('extracts Self.DNSName and strips the trailing dot', () => {
    const json = JSON.stringify({ Self: { DNSName: 'my-mac.tailnet.ts.net.' } })
    assert.equal(parseTailscaleHostname(json), 'my-mac.tailnet.ts.net')
  })

  it('returns null for malformed JSON', () => {
    assert.equal(parseTailscaleHostname('not json'), null)
  })

  it('returns null when Self.DNSName is missing', () => {
    assert.equal(parseTailscaleHostname(JSON.stringify({ Self: {} })), null)
  })
})
