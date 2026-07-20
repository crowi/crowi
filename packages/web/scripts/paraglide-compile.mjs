#!/usr/bin/env node
// Repo-owned wrapper around the `@inlang/paraglide-js` one-shot compile CLI.
//
// Why this exists (see `.reviews/codex-runs/investigate-turbopack-cache-corruption/out.json`,
// sol, high confidence, and the spec at
// `.feature-state/specs/feature-paraglide-compile-coordination.md`): the raw
// `paraglide-js compile` CLI runs with `cleanOutdir: true` — it recursively
// deletes the LIVE `packages/web/paraglide/` (1,000+ files) and rewrites it
// from scratch, with no cross-process lock. `predev` / `prebuild` / `pretest`
// / `pretype-check` all invoke it independently (turbo does not coordinate
// separate invocations), so a `pnpm test` or `pnpm type-check` run while
// `pnpm dev` is up can delete/recreate the tree Turbopack is actively
// reading, which can wedge `.next/dev/cache/turbopack` in a way that
// survives a restart (upstream: paraglide-js issue #659 — shared outdir
// race).
//
// This wrapper adds three mechanisms, all rooted at `.paraglide-meta/`
// (gitignored, OUTSIDE the `paraglide/` dir Turbopack watches, so none of
// this bookkeeping ever shows up as churn in the watched tree):
//   1. An interprocess lock (`compile.lock`, O_EXCL create) serializes every
//      invocation across processes. A lock older than the stale threshold is
//      only ever stolen once the PID it records is confirmed dead
//      (`kill(pid, 0)` / ESRCH) — the age threshold alone just decides when
//      to check, never licenses stealing from a merely slow-but-alive
//      holder.
//   2. A content-hash stamp (`stamp.json`) skips the whole compile with ZERO
//      writes under `paraglide/` when the inputs haven't changed.
//   3. When a recompile is needed, it happens in a disposable staging dir
//      (`staging/`) first; only the files that actually changed are then
//      published into the live `paraglide/` dir (leaves before the
//      `_index.js`/entry files that reference them, stale leaves removed
//      last) — the live dir is never deleted wholesale, so a concurrent
//      reader (Turbopack, but any other process too) never observes it
//      missing an entry file.
//
// Recovery (NOT automated here on purpose — see the spec's "やらないこと"):
// if `pnpm dev`'s Turbopack ever gets stuck on a stale/corrupt module graph
// (client error about a missing module factory that survives a restart):
//   1. stop `pnpm dev`
//   2. delete `packages/web/.next/dev/cache/turbopack`
//   3. restart `pnpm dev` and hard-reload the browser
// Do not delete this cache automatically on every `pnpm dev` start — that
// would mask a real regression instead of fixing the race above. If this
// reoccurs, preserve `.next/dev/cache/turbopack` before deleting it (copy it
// aside) so a future investigation can A/B it against a fresh one — this is
// the one open question sol's investigation could not close (the bad cache
// from the original incident was already gone by the time it ran).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── constants ──

const META_DIR_NAME = '.paraglide-meta'
const LIVE_DIR_NAME = 'paraglide'
const PROJECT_DIR_NAME = 'project.inlang'
const ENTRY_FILES = ['runtime.js', 'server.js', 'messages.js', 'registry.js']

// Compile invocation, defined once and shared verbatim between the actual
// CLI call (`compileToStaging`) and the content-hash input (`readInputs`) so
// the two can never drift out of sync with each other (a change to one that
// forgets the other would otherwise silently make the hash describe a
// different compile than the one that actually runs).
const COMPILE_STRATEGY_ARGS = ['--strategy', 'cookie', 'baseLocale']

// dev-ports.mjs (`scripts/dev-ports.mjs`) uses a 15s staleMs default, which
// fits its use case (allocating a port anchor is near-instant). A staged
// paraglide compile writes on the order of 1,000 files and can legitimately
// take much longer under CI load, so a lock held by a live (non-crashed)
// process must be given a lot more rope before we treat it as abandoned.
const DEFAULT_STALE_MS = 120_000
// A waiting invocation's total retry budget must comfortably exceed
// DEFAULT_STALE_MS, or a merely-slow-but-alive holder (not yet stale) would
// make a concurrent waiter give up with a spurious "could not acquire lock"
// error right in the scenario the larger staleMs above exists to tolerate.
// ~300 retries at up to 1000ms backoff each is on the order of minutes —
// comfortably longer than DEFAULT_STALE_MS, while still bounded (never an
// infinite hang in CI if something is genuinely wedged).
const DEFAULT_LOCK_RETRIES = 300
const DEFAULT_LOCK_RETRY_DELAY_MS = 100

// ── pure input hashing (AC4: any one of these inputs changing must change the hash) ──

/**
 * @param {{ settingsText: string, locales: string[], messagesTexts: Record<string, string>, paraglideVersion: string, compileArgsString: string }} inputs
 * @returns {string} sha256 hex digest
 */
export function hashInputs({ settingsText, locales, messagesTexts, paraglideVersion, compileArgsString }) {
  const hash = createHash('sha256')
  hash.update(`settings:${settingsText} `)
  for (const locale of locales) {
    hash.update(`messages:${locale}:${messagesTexts[locale] ?? ''} `)
  }
  hash.update(`paraglide-js:${paraglideVersion} `)
  hash.update(`compileArgs:${compileArgsString} `)
  return hash.digest('hex')
}

/**
 * Reads every input the compile output depends on: `project.inlang/settings.json`,
 * every locale's `messages/{locale}.json` (locale list comes from
 * `settings.locales`, not hardcoded, so a future locale addition is covered
 * automatically), the resolved `@inlang/paraglide-js` version (read straight
 * off its own installed `package.json` — no extra subprocess), and the fixed
 * compile-options string. `fs` is injectable so tests can point this at a
 * fixture dir without touching the real project.
 * @param {string} webDir
 * @param {{ fs?: typeof fs }} [opts]
 */
export function readInputs(webDir, { fs: fsImpl = fs } = {}) {
  const settingsPath = path.join(webDir, PROJECT_DIR_NAME, 'settings.json')
  const settingsText = fsImpl.readFileSync(settingsPath, 'utf8')
  const settings = JSON.parse(settingsText)
  const locales = Array.isArray(settings.locales) ? settings.locales : []
  const baseLocale = settings.baseLocale

  const messagesTexts = {}
  for (const locale of locales) {
    messagesTexts[locale] = fsImpl.readFileSync(path.join(webDir, 'messages', `${locale}.json`), 'utf8')
  }

  const paraglidePkgPath = path.join(webDir, 'node_modules', '@inlang', 'paraglide-js', 'package.json')
  const paraglideVersion = String(JSON.parse(fsImpl.readFileSync(paraglidePkgPath, 'utf8')).version)

  const compileArgsString = COMPILE_STRATEGY_ARGS.join(' ')
  const hash = hashInputs({ settingsText, locales, messagesTexts, paraglideVersion, compileArgsString })

  return { settingsText, locales, baseLocale, messagesTexts, paraglideVersion, compileArgsString, hash }
}

// ── lock (O_EXCL lockfile, adapted from scripts/dev-ports.mjs's acquireLock
// /stealStaleLock/withLock — same technique, larger staleMs default above.
// Kept self-contained here rather than importing dev-ports.mjs: that module
// is root dev-launcher tooling (not a shared library), and this wrapper
// ships as part of @crowi/web's own build tooling. See that file's doc
// comments for the full rationale behind the rename-first steal.) ──

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockBackoffDelay(attempt, base = 100, max = 1000) {
  return Math.min(base * 2 ** attempt, max)
}

/**
 * Reclaim a stale lockfile via an atomic rename instead of a bare unlink: a
 * bare `unlinkSync` steal can race a second stealer into deleting a brand
 * new lock that a first stealer already re-acquired. Renaming first means
 * only one of any number of racing stealers can ever win (see
 * `scripts/dev-ports.mjs`'s `stealStaleLock` for the full race walkthrough).
 * @param {string} lockPath
 * @returns {boolean} true if this call won the steal
 */
export function stealStaleLock(lockPath) {
  const stolenPath = `${lockPath}.steal.${process.pid}`
  try {
    fs.renameSync(lockPath, stolenPath)
  } catch {
    return false
  }
  try {
    fs.unlinkSync(stolenPath)
  } catch {
    /* already gone somehow; the steal itself still succeeded */
  }
  return true
}

/**
 * Reads the PID a lockfile claims to be held by (written verbatim as
 * `String(process.pid)` by `acquireLock`). Returns `null` for anything that
 * doesn't parse to a positive integer (missing file, empty/corrupt content,
 * a race where the file was created but not yet written to) — callers treat
 * `null` as "can't verify", not as "confirmed dead".
 * @param {string} lockPath
 * @returns {number | null}
 */
export function readLockPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Checks whether `pid` still refers to a live process, via the POSIX
 * `kill(pid, 0)` convention (send no signal, just test permission/existence)
 * that `process.kill` exposes cross-platform in Node. `ESRCH` means the
 * process is confirmed gone (safe to steal); `EPERM` means it exists but we
 * can't signal it (e.g. owned by another user) — treated as alive, since the
 * process is definitely still running. Any other/unexpected error (a
 * platform quirk we don't specifically know how to interpret) is also
 * treated as alive: this function only ever needs to widen "don't steal", so
 * erring toward "alive" is the safe default, never the reverse.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') return false
    return true
  }
}

/**
 * @param {string} lockPath
 * @param {{ retries?: number, retryDelayMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<() => void>} release function (idempotent)
 */
export async function acquireLock(lockPath, opts = {}) {
  const { retries = DEFAULT_LOCK_RETRIES, retryDelayMs = DEFAULT_LOCK_RETRY_DELAY_MS, staleMs = DEFAULT_STALE_MS } = opts
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* already gone */
        }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        const { mtimeMs } = fs.statSync(lockPath)
        if (Date.now() - mtimeMs > staleMs) {
          // `staleMs` alone is NOT sufficient grounds to steal: a genuinely
          // slow-but-alive compile (large CI load, see DEFAULT_STALE_MS's
          // own comment) crossing the threshold must NOT lose its lock to a
          // waiter, or two publishers can end up running the non-destructive
          // publish concurrently — exactly the corruption this wrapper
          // exists to prevent. The mtime threshold only decides WHEN to even
          // check; the recorded PID's *confirmed death* is what actually
          // licenses the steal. `readLockPid` returning `null` (missing/
          // unreadable/corrupt lock content, including the narrow window
          // where a holder created the lockfile via O_EXCL but hasn't
          // written its PID into it yet) must NOT be treated as "safe to
          // steal" — a suspended-then-resumed original holder could still be
          // alive behind that unreadable content, and stealing from it would
          // let it race a stealer's publish. Only a PID we can read AND
          // confirm dead licenses a steal; every other case (null, or a
          // live PID) keeps waiting/backing off below and — if the lock
          // truly never clears — eventually surfaces as the "could not
          // acquire lock" error once retries are exhausted, which is the
          // correct outcome (a human can inspect/remove a stuck lock) rather
          // than a silent, unverified steal.
          const heldPid = readLockPid(lockPath)
          if (heldPid !== null && !isPidAlive(heldPid)) {
            stealStaleLock(lockPath)
            continue // retry immediately regardless of who won the steal, no backoff
          }
        }
      } catch {
        continue // lock vanished between EEXIST and stat — retry immediately
      }
      if (attempt === retries) {
        throw new Error(`paraglide-compile: could not acquire lock at ${lockPath} (held by another process for >${staleMs}ms?)`)
      }
      await sleep(lockBackoffDelay(attempt, retryDelayMs))
    }
  }
  throw new Error(`paraglide-compile: could not acquire lock at ${lockPath}`)
}

/** Runs `fn` (may be async) while holding the lock, always releasing afterwards. */
export async function withLock(lockPath, fn, opts) {
  const release = await acquireLock(lockPath, opts)
  try {
    return await fn()
  } finally {
    release()
  }
}

// ── atomic write (write to a pid-suffixed temp file, then rename — same
// technique as scripts/dev-ports.mjs's writeRegistry) ──

/**
 * @param {string} filePath
 * @param {string | Buffer} data
 */
export function writeAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

/**
 * Tolerant stamp read: missing/corrupt stamp just means "not fresh", never
 * throws (mirrors dev-ports.mjs's readRegistry — a corrupt stamp shouldn't
 * wedge every invocation forever).
 * @param {string} stampPath
 * @returns {{ hash: string, updatedAt: string } | null}
 */
export function readStamp(stampPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    return parsed && typeof parsed === 'object' && typeof parsed.hash === 'string' ? parsed : null
  } catch {
    return null
  }
}

// ── staged compile (real CLI invocation; injectable for tests) ──

/**
 * Shells out to the locally-installed `paraglide-js` CLI, compiling into a
 * disposable staging dir. `--outdir` is the only flag that differs from the
 * previous direct invocation; `--project` / `--strategy` stay byte-identical
 * to what the hash input uses (see `COMPILE_STRATEGY_ARGS`).
 * @param {{ webDir: string, stagingDir: string }} args
 */
export function compileToStaging({ webDir, stagingDir }) {
  const bin = path.join(webDir, 'node_modules', '.bin', 'paraglide-js')
  const projectDir = path.join(webDir, PROJECT_DIR_NAME)
  const args = ['compile', '--project', projectDir, '--outdir', stagingDir, ...COMPILE_STRATEGY_ARGS]
  try {
    execFileSync(bin, args, { cwd: webDir, stdio: 'pipe', encoding: 'utf8' })
  } catch (err) {
    const stdout = err.stdout ?? ''
    const stderr = err.stderr ?? ''
    throw new Error(`paraglide-compile: \`paraglide-js compile\` failed:\n${stdout}${stderr}`)
  }
}

// ── staging validation ──

/**
 * Derives the expected leaf filenames from the baseLocale's message keys —
 * paraglide-js names each leaf module after its message key with `.`
 * replaced by `_` (e.g. `auth.common.language` → `auth_common_language.js`);
 * `$schema` is metadata, not a message. Verified against the actual compiler
 * output while implementing this wrapper.
 * @param {string} baseLocaleMessagesText
 * @returns {string[]}
 */
export function computeExpectedLeaves(baseLocaleMessagesText) {
  const parsed = JSON.parse(baseLocaleMessagesText)
  return Object.keys(parsed)
    .filter((key) => key !== '$schema')
    .map((key) => `${key.replace(/\./g, '_')}.js`)
}

/**
 * Minimal existence check (not a full content diff — that happens during
 * publish): the 4 entry files, `messages/_index.js`, and every expected leaf
 * must exist in the staging output before anything gets published from it.
 * @param {{ stagingDir: string, expectedLeaves: string[] }} args
 */
export function validateStaging({ stagingDir, expectedLeaves }) {
  const missing = []
  for (const name of ENTRY_FILES) {
    if (!fs.existsSync(path.join(stagingDir, name))) missing.push(name)
  }
  if (!fs.existsSync(path.join(stagingDir, 'messages', '_index.js'))) missing.push('messages/_index.js')
  for (const leaf of expectedLeaves) {
    if (!fs.existsSync(path.join(stagingDir, 'messages', leaf))) missing.push(`messages/${leaf}`)
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(', ')
    const more = missing.length > 10 ? `, and ${missing.length - 10} more` : ''
    throw new Error(`paraglide-compile: staged compile is missing ${missing.length} expected output file(s): ${shown}${more}`)
  }
}

// ── non-destructive staged publish ──

function listDirFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

function filesEqual(pathA, pathB) {
  try {
    return fs.readFileSync(pathA).equals(fs.readFileSync(pathB))
  } catch {
    return false
  }
}

/** @returns {boolean} whether a write actually happened */
function publishIfChanged(stagingPath, livePath) {
  if (fs.existsSync(livePath) && filesEqual(stagingPath, livePath)) return false
  writeAtomic(livePath, fs.readFileSync(stagingPath))
  return true
}

/**
 * Publishes only the files that changed, in an order that keeps the live
 * `paraglide/` dir referentially intact for any concurrent reader at every
 * point in time (never a `rm -rf` + recreate):
 *   1. leaf modules under `messages/` (the referenced side of the
 *      `messages.js` → `messages/_index.js` → leaf re-export chain, verified
 *      against the actual compiler output — write these first so nothing
 *      downstream can ever reference a leaf that isn't there yet).
 *   2. `messages/_index.js` and the top-level entry/static files (the
 *      referencing side) — includes anything paraglide-js emits at the
 *      staging root (`runtime.js`/`server.js`/`messages.js`/`registry.js`,
 *      `README.md`, `.gitignore`, `.prettierignore`), so first-time output
 *      equivalence with the raw CLI holds without hardcoding that list.
 *   3. leaves no longer produced get removed — safe now that `_index.js` no
 *      longer references them.
 * Every individual file write is itself atomic (`writeAtomic`), and a file
 * whose content is byte-identical to what's already live is left untouched
 * (mtime unchanged) — this is what makes the zero-write fast path AND the
 * single-message-diff case both hold.
 * @param {{ stagingDir: string, liveDir: string }} args
 * @returns {{ published: number, removed: number }}
 */
export function publish({ stagingDir, liveDir }) {
  fs.mkdirSync(path.join(liveDir, 'messages'), { recursive: true })

  const stagingLeaves = listDirFiles(path.join(stagingDir, 'messages')).filter((name) => name !== '_index.js')
  let published = 0
  for (const leaf of stagingLeaves) {
    if (publishIfChanged(path.join(stagingDir, 'messages', leaf), path.join(liveDir, 'messages', leaf))) published++
  }

  if (publishIfChanged(path.join(stagingDir, 'messages', '_index.js'), path.join(liveDir, 'messages', '_index.js'))) published++
  for (const name of listDirFiles(stagingDir)) {
    if (publishIfChanged(path.join(stagingDir, name), path.join(liveDir, name))) published++
  }

  const stagingLeafSet = new Set(stagingLeaves)
  let removed = 0
  for (const leaf of listDirFiles(path.join(liveDir, 'messages')).filter((name) => name !== '_index.js')) {
    if (!stagingLeafSet.has(leaf)) {
      fs.unlinkSync(path.join(liveDir, 'messages', leaf))
      removed++
    }
  }

  return { published, removed }
}

// ── orchestration ──

/**
 * Runs the full lock → hash-compare → (staged compile → validate → publish)
 * → stamp pipeline. `compileFn` is injectable so tests can substitute a
 * fixture compiler instead of shelling out to the real (network-fetching)
 * CLI — see `paraglide-compile.test.mjs`.
 * @param {{
 *   webDir: string,
 *   compileFn?: (args: { webDir: string, stagingDir: string }) => void | Promise<void>,
 *   staleMs?: number,
 *   retries?: number,
 *   retryDelayMs?: number,
 *   log?: (message: string) => void,
 * }} args
 */
export async function runWrapper({
  webDir,
  compileFn = compileToStaging,
  staleMs = DEFAULT_STALE_MS,
  retries,
  retryDelayMs,
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  const metaDir = path.join(webDir, META_DIR_NAME)
  fs.mkdirSync(metaDir, { recursive: true })
  const lockPath = path.join(metaDir, 'compile.lock')
  const stampPath = path.join(metaDir, 'stamp.json')
  const stagingDir = path.join(metaDir, 'staging')
  const liveDir = path.join(webDir, LIVE_DIR_NAME)

  return withLock(
    lockPath,
    async () => {
      const inputs = readInputs(webDir)
      const stamp = readStamp(stampPath)
      if (stamp && stamp.hash === inputs.hash) {
        log('paraglide-compile: inputs unchanged, skipping (zero-write).')
        return { skipped: true, published: 0, removed: 0 }
      }

      // staging/ itself is disposable scratch space (never watched, never
      // published as-is) — rebuilding it from scratch every run is fine; the
      // non-destructive contract only applies to the LIVE paraglide/ dir.
      fs.rmSync(stagingDir, { recursive: true, force: true })
      fs.mkdirSync(stagingDir, { recursive: true })
      await compileFn({ webDir, stagingDir })

      const expectedLeaves = computeExpectedLeaves(inputs.messagesTexts[inputs.baseLocale])
      validateStaging({ stagingDir, expectedLeaves })

      const { published, removed } = publish({ stagingDir, liveDir })

      // Stamp last, and only after a fully successful publish: if anything
      // above throws, the stamp is left untouched so the next run can't
      // mistake a failed/partial publish for "already fresh" and skip it.
      writeAtomic(stampPath, `${JSON.stringify({ hash: inputs.hash, updatedAt: new Date().toISOString() }, null, 2)}\n`)

      log(`paraglide-compile: published ${published} changed file(s), removed ${removed} stale leaf(ves).`)
      return { skipped: false, published, removed }
    },
    { staleMs, retries, retryDelayMs },
  )
}

// ── CLI entry point ──

async function main() {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    await runWrapper({ webDir })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}

// `import.meta.main` is Node 24+ (this repo pins `"node": "24.x"`). Guard so
// the module can be imported by a test (it re-exports every function above)
// without shelling out for real.
if (import.meta.main) {
  main()
}
