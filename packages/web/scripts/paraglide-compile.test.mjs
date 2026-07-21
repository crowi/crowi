// Repro suite for scripts/paraglide-compile.mjs (feature-paraglide-compile-coordination
// AC1-4). Run with `node --test` (built-in runner — same convention as
// scripts/dev-ports.test.mjs, joined into the `pnpm test:scripts` family via
// the root package.json glob), no dev dependency needed.
//
// Every fixture "webDir" is a throwaway temp dir with its own
// project.inlang/settings.json + messages/{locale}.json + a stub
// node_modules/@inlang/paraglide-js/package.json (just enough for
// `readInputs` to work) — never the real packages/web project. The compile
// step itself is a small in-repo fake (`fakeCompile` below) injected via
// `runWrapper`'s `compileFn` param, so this suite never shells out to the
// real (network-fetching) paraglide-js CLI — same "OS calls stubbed/
// injected, zero added devDependency" philosophy as dev-ports.test.mjs.
//
// AC1(a)'s "2 プロセス同時起動" concurrency check is covered at two levels:
// an in-process variant (two concurrent `runWrapper()` calls raced with
// `Promise.all` — cheap, and documents the lock's in-process behavior; this
// is also the pattern dev-ports.test.mjs's own `acquireLock` tests use for
// the same O_EXCL mechanism), AND a real cross-process variant that spawns
// two independent `node` processes running
// `paraglide-compile.crossprocess-worker.mjs` against the same fixture
// webDir, so the lock's atomicity is exercised across actual OS process
// boundaries too, not just the underlying syscalls from a single process.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  acquireLock,
  compileToStaging,
  computeExpectedLeaves,
  hashInputs,
  isPidAlive,
  publish,
  readInputs,
  readLockPid,
  readStamp,
  runWrapper,
  sleep,
  stealStaleLock,
  validateStaging,
  writeAtomic,
} from './paraglide-compile.mjs'
import { fakeCompile } from './paraglide-compile.test-fixtures.mjs'

// Filesystem mtime resolution can be coarse (e.g. 1s on some platforms); every
// "unchanged content must not rewrite the file" assertion below waits past it
// first, so an (incorrect) unconditional rewrite would be observable as a
// changed mtime.
const PAST_MTIME_RESOLUTION_MS = 1100

let tmpRoot

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crowi-paraglide-compile-test-'))
})

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** A throwaway fixture project: settings.json + messages/{locale}.json + a stub paraglide-js package.json. */
function makeFixtureWebDir({ locales = ['ja', 'en'], baseLocale = 'ja', messagesByLocale, paraglideVersion = '9.9.9-test' }) {
  const webDir = fs.mkdtempSync(path.join(tmpRoot, 'web-'))
  fs.mkdirSync(path.join(webDir, 'project.inlang'), { recursive: true })
  fs.writeFileSync(
    path.join(webDir, 'project.inlang', 'settings.json'),
    `${JSON.stringify(
      {
        $schema: 'https://inlang.com/schema/project-settings',
        baseLocale,
        locales,
        modules: ['https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4.4.0/dist/index.js'],
        'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' },
      },
      null,
      2,
    )}\n`,
  )
  fs.mkdirSync(path.join(webDir, 'messages'), { recursive: true })
  for (const locale of locales) {
    fs.writeFileSync(path.join(webDir, 'messages', `${locale}.json`), `${JSON.stringify(messagesByLocale[locale], null, 2)}\n`)
  }
  fs.mkdirSync(path.join(webDir, 'node_modules', '@inlang', 'paraglide-js'), { recursive: true })
  fs.writeFileSync(
    path.join(webDir, 'node_modules', '@inlang', 'paraglide-js', 'package.json'),
    JSON.stringify({ name: '@inlang/paraglide-js', version: paraglideVersion }),
  )
  return webDir
}

// `fakeCompile` (the compile fixture standing in for the real `paraglide-js`
// CLI) lives in ./paraglide-compile.test-fixtures.mjs, shared with
// paraglide-compile.crossprocess-worker.mjs so the two never drift.

const CROSSPROCESS_WORKER_PATH = fileURLToPath(new URL('./paraglide-compile.crossprocess-worker.mjs', import.meta.url))

/**
 * Spawns `paraglide-compile.crossprocess-worker.mjs` as an independent `node`
 * process against `webDir`, for the real-OS-process variant of the AC1(a)
 * concurrency test — the worker itself runs `runWrapper` with a fixture
 * `compileFn` (see that file), so this never shells out to the real
 * (network-fetching) paraglide-js CLI.
 * @param {string} webDir
 * @returns {Promise<{ skipped: boolean, published: number, removed: number }>}
 */
function spawnCrossProcessWorker(webDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CROSSPROCESS_WORKER_PATH, webDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`paraglide-compile.crossprocess-worker exited ${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (err) {
        reject(new Error(`paraglide-compile.crossprocess-worker printed non-JSON stdout: ${stdout}\n(${err})`))
      }
    })
  })
}

/**
 * Starts a 1ms poller that flips a flag if any of the 4 entry files or
 * `messages/_index.js` is ever observed missing from `liveDir` — shared by
 * both AC1(a) variants below (in-process and real-OS-process) to assert the
 * live dir never goes referentially incomplete mid-publish. Caller must
 * `clearInterval(handle)` when done, even on failure.
 * @param {string} liveDir
 * @returns {{ handle: NodeJS.Timeout, wasMissing: () => boolean }}
 */
function watchForMissingEntryFile(liveDir) {
  let missingObserved = false
  const handle = setInterval(() => {
    for (const name of ['runtime.js', 'server.js', 'messages.js', 'registry.js']) {
      if (!fs.existsSync(path.join(liveDir, name))) missingObserved = true
    }
    if (!fs.existsSync(path.join(liveDir, 'messages', '_index.js'))) missingObserved = true
  }, 1)
  return { handle, wasMissing: () => missingObserved }
}

function collectMtimes(dir) {
  const out = {}
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, relPath)
      else out[relPath] = fs.statSync(abs).mtimeMs
    }
  }
  walk(dir, '')
  return out
}

const FIXTURE_MESSAGES = {
  ja: { $schema: 'https://inlang.com/schema/inlang-message-format', 'greeting.hello': 'こんにちは', 'greeting.bye': 'さようなら', 'nav.home': 'ホーム' },
  en: { $schema: 'https://inlang.com/schema/inlang-message-format', 'greeting.hello': 'Hello', 'greeting.bye': 'Goodbye', 'nav.home': 'Home' },
}

// ── AC4: hash inputs — changing any one of the four inputs must change the hash ──

describe('hashInputs (AC4)', () => {
  const base = {
    settingsText: '{"baseLocale":"ja","locales":["ja","en"]}',
    locales: ['ja', 'en'],
    messagesTexts: { ja: '{"greeting.hello":"こんにちは"}', en: '{"greeting.hello":"Hello"}' },
    paraglideVersion: '2.18.0',
    compileArgsString: '--strategy cookie baseLocale',
  }

  it('is deterministic for identical inputs', () => {
    assert.equal(hashInputs(base), hashInputs({ ...base }))
  })

  it('changes when settings.json text changes', () => {
    assert.notEqual(hashInputs(base), hashInputs({ ...base, settingsText: '{"baseLocale":"ja","locales":["ja","en","fr"]}' }))
  })

  it('changes when any locale messages text changes', () => {
    assert.notEqual(hashInputs(base), hashInputs({ ...base, messagesTexts: { ...base.messagesTexts, en: '{"greeting.hello":"Hiya"}' } }))
  })

  it('changes when the resolved paraglide-js version changes', () => {
    assert.notEqual(hashInputs(base), hashInputs({ ...base, paraglideVersion: '2.19.0' }))
  })

  it('changes when the compile options string changes', () => {
    assert.notEqual(hashInputs(base), hashInputs({ ...base, compileArgsString: '--strategy baseLocale' }))
  })
})

describe('readInputs', () => {
  it('reads settings/messages/version off a fixture webDir and folds them into the same hash hashInputs would produce', () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    const inputs = readInputs(webDir)
    assert.equal(inputs.baseLocale, 'ja')
    assert.deepEqual(inputs.locales, ['ja', 'en'])
    assert.equal(inputs.paraglideVersion, '9.9.9-test')
    assert.equal(
      inputs.hash,
      hashInputs({
        settingsText: inputs.settingsText,
        locales: inputs.locales,
        messagesTexts: inputs.messagesTexts,
        paraglideVersion: inputs.paraglideVersion,
        compileArgsString: inputs.compileArgsString,
      }),
    )
  })
})

// ── computeExpectedLeaves / validateStaging ──

describe('computeExpectedLeaves', () => {
  it('maps message keys to <key with . replaced by _>.js, excluding $schema', () => {
    const leaves = computeExpectedLeaves(JSON.stringify(FIXTURE_MESSAGES.ja))
    assert.deepEqual(leaves.sort(), ['greeting_bye.js', 'greeting_hello.js', 'nav_home.js'])
  })
})

describe('validateStaging', () => {
  it('throws listing every missing entry/index/leaf file (and not the one that does exist)', () => {
    const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'staging-'))
    fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
    fs.writeFileSync(path.join(stagingDir, 'runtime.js'), '')
    let message = ''
    assert.throws(() => validateStaging({ stagingDir, expectedLeaves: ['greeting_hello.js'] }), (err) => {
      message = err.message
      return true
    })
    for (const expectedMissing of ['server.js', 'messages.js', 'registry.js', 'messages/_index.js', 'messages/greeting_hello.js']) {
      assert.ok(message.includes(expectedMissing), `expected the error to mention "${expectedMissing}": ${message}`)
    }
    assert.ok(!message.includes('runtime.js'), 'runtime.js exists and must not be reported as missing')
  })

  it('passes once every entry file, _index.js, and expected leaf exists', () => {
    const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'staging-'))
    fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
    for (const name of ['runtime.js', 'server.js', 'messages.js', 'registry.js']) fs.writeFileSync(path.join(stagingDir, name), '')
    fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), '')
    fs.writeFileSync(path.join(stagingDir, 'messages', 'greeting_hello.js'), '')
    assert.doesNotThrow(() => validateStaging({ stagingDir, expectedLeaves: ['greeting_hello.js'] }))
  })
})

// ── publish: content-based diffing, referential publish order, stale-leaf removal ──

describe('publish', () => {
  it('publishes new leaves/entries into an empty live dir and reports the count', () => {
    const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'staging-'))
    const liveDir = path.join(fs.mkdtempSync(path.join(tmpRoot, 'live-')), 'paraglide')
    fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
    fs.writeFileSync(path.join(stagingDir, 'runtime.js'), 'runtime')
    fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), 'index')
    fs.writeFileSync(path.join(stagingDir, 'messages', 'a.js'), 'a')
    fs.writeFileSync(path.join(stagingDir, 'messages', 'b.js'), 'b')

    const result = publish({ stagingDir, liveDir })

    assert.equal(result.published, 4)
    assert.equal(result.removed, 0)
    assert.equal(fs.readFileSync(path.join(liveDir, 'runtime.js'), 'utf8'), 'runtime')
    assert.equal(fs.readFileSync(path.join(liveDir, 'messages', 'a.js'), 'utf8'), 'a')
  })

  it('leaves byte-identical files untouched (mtime unchanged) and only republishes what actually changed', async () => {
    const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'staging-'))
    const liveDir = path.join(fs.mkdtempSync(path.join(tmpRoot, 'live-')), 'paraglide')
    fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
    fs.writeFileSync(path.join(stagingDir, 'runtime.js'), 'runtime')
    fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), 'index')
    fs.writeFileSync(path.join(stagingDir, 'messages', 'a.js'), 'a')
    publish({ stagingDir, liveDir })
    const before = collectMtimes(liveDir)

    await sleep(PAST_MTIME_RESOLUTION_MS)

    // Re-publish the SAME content from a freshly-regenerated staging dir
    // (mirrors runWrapper always recreating staging/ from scratch) plus one
    // genuinely changed leaf.
    fs.writeFileSync(path.join(stagingDir, 'messages', 'a.js'), 'a-changed')
    const result = publish({ stagingDir, liveDir })

    assert.equal(result.published, 1, 'only the one changed leaf should be republished')
    const after = collectMtimes(liveDir)
    assert.equal(after['runtime.js'], before['runtime.js'], 'unchanged entry file must keep its mtime')
    assert.equal(after['messages/_index.js'], before['messages/_index.js'], 'unchanged _index.js must keep its mtime')
    assert.notEqual(after['messages/a.js'], before['messages/a.js'], 'the changed leaf must be rewritten')
    assert.equal(fs.readFileSync(path.join(liveDir, 'messages', 'a.js'), 'utf8'), 'a-changed')
  })

  it('removes a live leaf no longer produced by staging, after _index.js stops referencing it', () => {
    const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'staging-'))
    const liveDir = path.join(fs.mkdtempSync(path.join(tmpRoot, 'live-')), 'paraglide')
    fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
    fs.writeFileSync(path.join(stagingDir, 'runtime.js'), 'runtime')
    fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), "export * from './a.js'\nexport * from './b.js'\n")
    fs.writeFileSync(path.join(stagingDir, 'messages', 'a.js'), 'a')
    fs.writeFileSync(path.join(stagingDir, 'messages', 'b.js'), 'b')
    publish({ stagingDir, liveDir })
    assert.ok(fs.existsSync(path.join(liveDir, 'messages', 'b.js')))

    // b.js's message key was removed: the next staging output no longer has it.
    fs.rmSync(path.join(stagingDir, 'messages', 'b.js'))
    fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), "export * from './a.js'\n")

    const result = publish({ stagingDir, liveDir })

    assert.equal(result.removed, 1)
    assert.ok(!fs.existsSync(path.join(liveDir, 'messages', 'b.js')), 'the stale leaf must be deleted from the live dir')
    assert.equal(fs.readFileSync(path.join(liveDir, 'messages', '_index.js'), 'utf8'), "export * from './a.js'\n", "_index.js must no longer reference the removed leaf")
  })
})

// ── lock: reused from scripts/dev-ports.mjs's own test coverage style ──

describe('acquireLock / stealStaleLock', () => {
  it('a second acquire waits for the first release instead of racing it', async () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    const release1 = await acquireLock(lockPath, { retries: 5, retryDelayMs: 10 })

    let acquired2 = false
    const p2 = acquireLock(lockPath, { retries: 30, retryDelayMs: 10 }).then((release2) => {
      acquired2 = true
      release2()
    })

    await sleep(30)
    assert.equal(acquired2, false, 'must not acquire while the first holder is still live')
    release1()
    await p2
    assert.equal(acquired2, true)
  })

  it('only the first of two racing steals on the same stale lock wins', () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    fs.writeFileSync(lockPath, '999999')
    assert.equal(stealStaleLock(lockPath), true)
    assert.equal(stealStaleLock(lockPath), false)
  })

  it('reclaims a lock past the stale threshold whose recorded PID is confirmed dead (AC1(d))', async () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    fs.writeFileSync(lockPath, '999999999') // definitely-not-a-real PID
    const staleMtime = new Date(Date.now() - 200_000)
    fs.utimesSync(lockPath, staleMtime, staleMtime)

    const release = await acquireLock(lockPath, { retries: 10, retryDelayMs: 10, staleMs: 120_000 })
    release()
  })

  it('does NOT steal a lock past the stale threshold whose recorded PID is still alive — mtime alone must never license a steal', async () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    fs.writeFileSync(lockPath, String(process.pid)) // this test process itself: guaranteed alive
    const staleMtime = new Date(Date.now() - 200_000)
    fs.utimesSync(lockPath, staleMtime, staleMtime)

    await assert.rejects(
      () => acquireLock(lockPath, { retries: 3, retryDelayMs: 5, staleMs: 100 }),
      /could not acquire lock/,
      'a live PID must keep its lock even though the mtime is well past the (much smaller here) stale threshold',
    )
    assert.ok(fs.existsSync(lockPath), 'the live-PID holder lock must still be there — it was never stolen')
  })

  it('does NOT steal a lock past the stale threshold whose content is EMPTY — an unreadable PID must never be treated as confirmed-dead (regression)', async () => {
    // Reproduces the exact window between a holder's `fs.openSync(lockPath,
    // 'wx')` and its subsequent `fs.writeSync(fd, String(process.pid))`: the
    // lockfile exists but records no PID yet. `readLockPid` returns `null`
    // for this content, and `null` must mean "can't verify" — never "safe to
    // steal" — or a holder merely suspended in that window could resume and
    // overlap with whoever stole its lock.
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    fs.writeFileSync(lockPath, '')
    const staleMtime = new Date(Date.now() - 200_000)
    fs.utimesSync(lockPath, staleMtime, staleMtime)
    assert.equal(readLockPid(lockPath), null, 'precondition: empty content must be unreadable as a PID')

    await assert.rejects(
      () => acquireLock(lockPath, { retries: 3, retryDelayMs: 5, staleMs: 100 }),
      /could not acquire lock/,
      'an empty (unverifiable) lock must never be stolen, even well past the stale threshold',
    )
    assert.ok(fs.existsSync(lockPath), 'the empty-content lock must still be there — it was never stolen')
  })

  it('does NOT steal a lock past the stale threshold whose content is CORRUPT (non-numeric) — an unreadable PID must never be treated as confirmed-dead (regression)', async () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    fs.writeFileSync(lockPath, 'not-a-pid')
    const staleMtime = new Date(Date.now() - 200_000)
    fs.utimesSync(lockPath, staleMtime, staleMtime)
    assert.equal(readLockPid(lockPath), null, 'precondition: corrupt content must be unreadable as a PID')

    await assert.rejects(
      () => acquireLock(lockPath, { retries: 3, retryDelayMs: 5, staleMs: 100 }),
      /could not acquire lock/,
      'a corrupt (unverifiable) lock must never be stolen, even well past the stale threshold',
    )
    assert.ok(fs.existsSync(lockPath), 'the corrupt-content lock must still be there — it was never stolen')
  })
})

describe('isPidAlive / readLockPid', () => {
  it('isPidAlive is true for the current process and false for a PID far beyond any real PID space', () => {
    assert.equal(isPidAlive(process.pid), true)
    assert.equal(isPidAlive(999999999), false)
  })

  it('isPidAlive treats non-positive/non-integer input as not alive', () => {
    assert.equal(isPidAlive(0), false)
    assert.equal(isPidAlive(-1), false)
    assert.equal(isPidAlive(1.5), false)
  })

  it('readLockPid parses the PID a lockfile records, and returns null for missing/corrupt content', () => {
    const lockPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'lock-')), 'compile.lock')
    assert.equal(readLockPid(lockPath), null)
    fs.writeFileSync(lockPath, '4242')
    assert.equal(readLockPid(lockPath), 4242)
    fs.writeFileSync(lockPath, 'not-a-pid')
    assert.equal(readLockPid(lockPath), null)
  })
})

describe('writeAtomic / readStamp', () => {
  it('round-trips a stamp and readStamp tolerates a missing/corrupt file', () => {
    const stampPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'stamp-')), 'stamp.json')
    assert.equal(readStamp(stampPath), null)
    writeAtomic(stampPath, JSON.stringify({ hash: 'abc', updatedAt: '2026-01-01T00:00:00Z' }))
    assert.deepEqual(readStamp(stampPath), { hash: 'abc', updatedAt: '2026-01-01T00:00:00Z' })

    fs.writeFileSync(stampPath, 'not json{{{')
    assert.equal(readStamp(stampPath), null)
  })
})

// ── runWrapper: end-to-end orchestration (AC1 a-d) ──

describe('runWrapper', () => {
  it('AC1(b): a second run with unchanged inputs writes nothing under paraglide/ (every mtime unchanged) and reports skipped', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    const first = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(first.skipped, false)
    const before = collectMtimes(path.join(webDir, 'paraglide'))

    await sleep(PAST_MTIME_RESOLUTION_MS)

    const second = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(second.skipped, true)
    assert.equal(second.published, 0)
    const after = collectMtimes(path.join(webDir, 'paraglide'))
    assert.deepEqual(after, before, 'no file under paraglide/ may be touched when inputs are unchanged')
  })

  it('AC1(c): editing one message in one locale republishes only that leaf, leaving _index.js/entries and every other leaf untouched', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    const before = collectMtimes(path.join(webDir, 'paraglide'))
    await sleep(PAST_MTIME_RESOLUTION_MS)

    const jaPath = path.join(webDir, 'messages', 'ja.json')
    const ja = JSON.parse(fs.readFileSync(jaPath, 'utf8'))
    ja['greeting.hello'] = 'やあ'
    fs.writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`)

    const result = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(result.skipped, false)

    const after = collectMtimes(path.join(webDir, 'paraglide'))
    const changed = Object.keys(after).filter((relPath) => after[relPath] !== before[relPath])
    assert.deepEqual(changed, ['messages/greeting_hello.js'], 'only the edited message\'s own leaf file may change')
  })

  it('a matching stamp does NOT skip when the live output it describes has been removed (repro: fast path trusted stamp.json alone)', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    const first = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(first.skipped, false)

    // Simulate external interference (a manual `rm -rf`, a partial disk
    // issue, some other tool) that removes live output without touching
    // `.paraglide-meta/stamp.json` — the stamp alone must not be enough to
    // suppress regeneration once the output it attests to is gone.
    fs.rmSync(path.join(webDir, 'paraglide', 'messages', 'greeting_hello.js'))

    const second = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(second.skipped, false, 'a stamp describing missing live output must not take the zero-write skip path')
    assert.ok(fs.existsSync(path.join(webDir, 'paraglide', 'messages', 'greeting_hello.js')), 'the missing leaf must be republished')
  })

  it('a matching stamp does NOT skip when an expected leaf has been replaced by a directory (repro: existsSync alone does not check file type)', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })

    // A directory (or a symlink to one) still satisfies a bare
    // `fs.existsSync` check while being unusable as the compiled leaf it
    // replaced.
    const leafPath = path.join(webDir, 'paraglide', 'messages', 'greeting_hello.js')
    fs.rmSync(leafPath)
    fs.mkdirSync(leafPath)

    const result = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(result.skipped, false, 'a stamp describing a leaf replaced by a directory must not take the zero-write skip path')
    assert.ok(fs.statSync(leafPath).isFile(), 'the directory must be replaced by the real compiled leaf file')
  })

  it('recovers when paraglide/messages itself has been replaced by a regular file (repro: mkdirSync cannot create a dir where a file already exists)', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })

    const messagesDirPath = path.join(webDir, 'paraglide', 'messages')
    fs.rmSync(messagesDirPath, { recursive: true, force: true })
    fs.writeFileSync(messagesDirPath, 'not a directory')

    const result = await runWrapper({ webDir, compileFn: fakeCompile, retries: 10, retryDelayMs: 10 })
    assert.equal(result.skipped, false)
    assert.ok(fs.statSync(messagesDirPath).isDirectory(), 'messages/ must be recreated as a real directory')
    assert.ok(fs.existsSync(path.join(messagesDirPath, '_index.js')))
  })

  it('AC1(d): a stale lock left by a dead PID is reclaimed and the run proceeds', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    const metaDir = path.join(webDir, '.paraglide-meta')
    fs.mkdirSync(metaDir, { recursive: true })
    const lockPath = path.join(metaDir, 'compile.lock')
    fs.writeFileSync(lockPath, '999999999') // definitely-not-a-real PID
    const staleMtime = new Date(Date.now() - 200_000)
    fs.utimesSync(lockPath, staleMtime, staleMtime)

    const result = await runWrapper({ webDir, compileFn: fakeCompile, staleMs: 120_000, retries: 20, retryDelayMs: 10 })

    assert.equal(result.skipped, false)
    assert.ok(fs.existsSync(path.join(webDir, 'paraglide', 'runtime.js')))
    assert.ok(!fs.existsSync(lockPath), 'the lock must be released again after the run')
  })

  it('AC1(a): two concurrent invocations never overlap the compile/publish critical section, and the live dir never goes missing an entry file once published', async () => {
    const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })
    let inCriticalSection = 0
    let overlapDetected = false

    const slowFakeCompile = async (args) => {
      inCriticalSection++
      if (inCriticalSection > 1) overlapDetected = true
      await sleep(20) // widen the race window so a real overlap would be caught
      await fakeCompile(args)
      inCriticalSection--
    }

    // Seed a baseline (first-ever run — the live dir is legitimately absent
    // before this) so the poller below only has to watch a dir that's
    // already supposed to stay populated.
    await runWrapper({ webDir, compileFn: slowFakeCompile, retries: 20, retryDelayMs: 10 })

    // Change one message so BOTH concurrent calls see a hash mismatch and
    // race to actually recompile+publish (the loser waits on the lock, then
    // re-reads the now-current stamp and takes the zero-write skip path).
    const jaPath = path.join(webDir, 'messages', 'ja.json')
    const ja = JSON.parse(fs.readFileSync(jaPath, 'utf8'))
    ja['greeting.hello'] = 'concurrent-edit'
    fs.writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`)

    const liveDir = path.join(webDir, 'paraglide')
    const watcher = watchForMissingEntryFile(liveDir)

    let a
    let b
    try {
      ;[a, b] = await Promise.all([
        runWrapper({ webDir, compileFn: slowFakeCompile, retries: 50, retryDelayMs: 10 }),
        runWrapper({ webDir, compileFn: slowFakeCompile, retries: 50, retryDelayMs: 10 }),
      ])
    } finally {
      // Always clear the poller, even on failure — an uncleared `setInterval`
      // would otherwise keep the `node --test` process alive indefinitely
      // instead of just failing this one test.
      clearInterval(watcher.handle)
    }

    assert.equal(overlapDetected, false, 'the lock must fully serialize concurrent compile/publish runs')
    assert.equal(watcher.wasMissing(), false, 'no entry file may ever be observably missing from the live dir once published')
    // Exactly one of the two racers should have done the real work; the
    // other converges on the now-fresh stamp and skips.
    assert.equal([a.skipped, b.skipped].filter((skipped) => skipped === false).length, 1)
  })

  it(
    'AC1(a) [real OS processes]: two independently-spawned node processes running the wrapper never overlap, ' +
      'and the live dir never goes missing an entry file once published',
    async () => {
      const webDir = makeFixtureWebDir({ messagesByLocale: FIXTURE_MESSAGES })

      // Seed a baseline in-process first (first-ever run — the live dir is
      // legitimately absent before this), same reasoning as the in-process
      // variant above: the poller below only has to watch a dir that is
      // already supposed to stay populated throughout.
      await runWrapper({ webDir, compileFn: fakeCompile, retries: 20, retryDelayMs: 10 })

      // Change one message so BOTH spawned processes see a hash mismatch and
      // race to actually recompile+publish (the loser waits on the real,
      // filesystem-level O_EXCL lock, then re-reads the now-current stamp
      // and takes the zero-write skip path).
      const jaPath = path.join(webDir, 'messages', 'ja.json')
      const ja = JSON.parse(fs.readFileSync(jaPath, 'utf8'))
      ja['greeting.hello'] = 'cross-process-edit'
      fs.writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`)

      const liveDir = path.join(webDir, 'paraglide')
      const watcher = watchForMissingEntryFile(liveDir)

      let a
      let b
      try {
        ;[a, b] = await Promise.all([spawnCrossProcessWorker(webDir), spawnCrossProcessWorker(webDir)])
      } finally {
        // Always clear the poller, even on failure — see the in-process
        // AC1(a) test above for why an uncleared interval is worse than just
        // this one test failing.
        clearInterval(watcher.handle)
      }

      assert.equal(watcher.wasMissing(), false, 'no entry file may ever be observably missing from the live dir once published, even across real OS processes')
      // Exactly one of the two independently-spawned processes should have
      // done the real work; the other converges on the now-fresh stamp
      // (written by whichever won the real O_EXCL lock first) and skips.
      assert.equal([a.skipped, b.skipped].filter((skipped) => skipped === false).length, 1)
    },
  )
})

// ── compileToStaging: sanity-check the real CLI invocation shape (does not run it) ──

describe('compileToStaging', () => {
  it('is exported as a function (the real, non-injected default used by main())', () => {
    assert.equal(typeof compileToStaging, 'function')
  })
})

// ── AC2: the 4 lifecycle hooks point at the wrapper, and no raw `paraglide-js compile` remains ──

describe('packages/web/package.json wiring (AC2)', () => {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

  it('paraglide:compile invokes the wrapper, not the raw paraglide-js CLI', () => {
    assert.match(pkg.scripts['paraglide:compile'], /scripts\/paraglide-compile\.mjs/)
    assert.doesNotMatch(pkg.scripts['paraglide:compile'], /paraglide-js compile/)
  })

  it('predev/prebuild/pretest/pretype-check all still delegate to paraglide:compile', () => {
    for (const hook of ['predev', 'prebuild', 'pretest', 'pretype-check']) {
      assert.equal(pkg.scripts[hook], 'pnpm paraglide:compile', `${hook} must delegate to the paraglide:compile script`)
    }
  })
})

describe('packages/web/.gitignore (AC2)', () => {
  it('ignores .paraglide-meta/', () => {
    const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.gitignore')
    const text = fs.readFileSync(gitignorePath, 'utf8')
    assert.match(text, /\.paraglide-meta\//)
  })
})
