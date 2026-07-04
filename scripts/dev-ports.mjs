// Shared, zero-dep dev-port scheme for parallel `gw` worktrees
// (feature-dev-portal-worktree §1/§3).
//
// One worktree = one contiguous 4-port block (stride 10):
//   api = anchor / web = anchor+1 / site = anchor+2 / proxy = anchor+3
//
// The registry (`~/.crowi-dev-ports.json`, outside the repo so it is shared
// across every worktree checkout) maps a normalized worktree key to its
// anchor. `main` is pinned to 4301 (today's ports, zero migration); every
// other worktree gets the next free 4-port block starting at 4310.
//
// This module is imported by `scripts/dev.mjs` (launcher), `scripts/migrate.mjs`
// (destructive-migration guard) and `scripts/dev-portal/` (worktree listing). It
// is pure/testable except for the registry file + lock file I/O and the OS
// port probe, which are exported too so tests can substitute temp paths /
// fake probes instead of touching the real filesystem or network.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// ── constants ──

export const MAIN_KEY = 'main'
export const MAIN_ANCHOR = 4301
export const AUTO_START_ANCHOR = 4310
export const STRIDE = 10
export const BLOCK_SIZE = 4 // api, web, site, proxy

export const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), '.crowi-dev-ports.json')
export const DEFAULT_LOCK_PATH = path.join(os.homedir(), '.crowi-dev-ports.lock')

// ── worktree key normalization (§1, spec-review "confirmed") ──

/**
 * Normalize a worktree directory into the registry key: the dir basename with
 * a leading `crowi-` prefix stripped (branch names contain `/` and can't be
 * used directly, e.g. `feature-x/impl`). The main checkout's basename is
 * `crowi` (no prefix to strip) → special-cased to `"main"`.
 * @param {string} worktreeDir absolute path to the worktree root
 * @returns {string}
 */
export function normalizeWorktreeKey(worktreeDir) {
  const base = path.basename(worktreeDir)
  if (base === 'crowi') return MAIN_KEY
  return base.startsWith('crowi-') ? base.slice('crowi-'.length) : base
}

// ── port scheme ──

/**
 * The 4-port block for an anchor. Pure.
 * @param {number} anchor
 */
export function portsForAnchor(anchor) {
  return { api: anchor, web: anchor + 1, site: anchor + 2, proxy: anchor + 3 }
}

// ── registry read/write (atomic, sorted for stable diffs when eyeballed) ──

/**
 * @param {string} [registryPath]
 * @returns {Record<string, number>}
 */
export function readRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    // A corrupt registry shouldn't wedge every worktree's `pnpm dev` forever —
    // start fresh (the worst case is a one-time re-allocation of anchors).
    return {}
  }
}

/**
 * Atomic write (write to a pid-suffixed temp file, then rename) so a reader
 * never observes a half-written registry.
 * @param {Record<string, number>} registry
 * @param {string} [registryPath]
 */
export function writeRegistry(registry, registryPath = DEFAULT_REGISTRY_PATH) {
  const sorted = Object.fromEntries(Object.keys(registry).sort().map((k) => [k, registry[k]]))
  const tmp = `${registryPath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`)
  fs.renameSync(tmp, registryPath)
}

// ── lock (O_EXCL lockfile, zero-dep) ──

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with a ceiling, mirrors `dev.mjs`'s `backoffDelay`. */
export function lockBackoffDelay(attempt, base = 100, max = 1000) {
  return Math.min(base * 2 ** attempt, max)
}

/**
 * Acquire the registry lock: an `O_EXCL` lockfile (atomic create-if-absent,
 * portable, no dependency). Retries with backoff while the lock is held by a
 * live process; steals a stale lock (older than `staleMs`, e.g. a crashed
 * `pnpm dev` that never released it) after confirming it's still there.
 * @param {string} [lockPath]
 * @param {{ retries?: number, retryDelayMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<() => void>} release function (idempotent)
 */
export async function acquireLock(lockPath = DEFAULT_LOCK_PATH, opts = {}) {
  const { retries = 50, retryDelayMs = 100, staleMs = 15000 } = opts
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
          try {
            fs.unlinkSync(lockPath)
          } catch {
            /* another process already reclaimed it */
          }
          continue // retry immediately, no backoff
        }
      } catch {
        continue // lock vanished between EEXIST and stat — retry immediately
      }
      if (attempt === retries) {
        throw new Error(`dev-ports: could not acquire lock at ${lockPath} (held by another process for >${staleMs}ms?)`)
      }
      await sleep(lockBackoffDelay(attempt, retryDelayMs))
    }
  }
  throw new Error(`dev-ports: could not acquire lock at ${lockPath}`)
}

/** Run `fn` while holding the lock, always releasing afterwards. */
export async function withLock(lockPath, fn, opts) {
  const release = await acquireLock(lockPath, opts)
  try {
    return await fn()
  } finally {
    release()
  }
}

// ── OS port probing (real impl; tests inject a fake `isRangeFree`) ──

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true))
    })
  })
}

/**
 * Whether an anchor's whole 4-port block is currently bindable. Guards
 * against handing out an anchor that collides with something outside the
 * registry (a stray process, a different tool).
 * @param {number} anchor
 * @param {number} [size]
 */
export async function isAnchorBlockFree(anchor, size = BLOCK_SIZE) {
  for (let i = 0; i < size; i++) {
    // Sequential on purpose: bail out on the first taken port instead of
    // opening `size` sockets concurrently for a block we may reject anyway.
    if (!(await isPortFree(anchor + i))) return false
  }
  return true
}

/**
 * Find the smallest unused anchor at-or-after `start` (stride apart) that is
 * neither already claimed in the registry (`used`) nor bound on the OS.
 * @param {{ used: Set<number> | number[], start?: number, stride?: number, isRangeFree?: (anchor: number) => Promise<boolean>, maxAttempts?: number }} opts
 * @returns {Promise<number>}
 */
export async function pickNextAnchor(opts) {
  const { used, start = AUTO_START_ANCHOR, stride = STRIDE, isRangeFree = isAnchorBlockFree, maxAttempts = 1000 } = opts
  const usedSet = used instanceof Set ? used : new Set(used)
  let anchor = start
  for (let i = 0; i < maxAttempts; i++) {
    if (!usedSet.has(anchor) && (await isRangeFree(anchor))) return anchor
    anchor += stride
  }
  throw new Error(`dev-ports: no free anchor found starting at ${start} (stride ${stride}, ${maxAttempts} attempts)`)
}

// ── top-level allocation (registry + lock + auto-pick, orchestrated) ──

/**
 * Resolve (and persist) the anchor for `key`:
 *   - `key === "main"` (and no explicit override) → always 4301.
 *   - `explicitAnchor` set → pinned, persisted (`--anchor` CLI flag).
 *   - already in the registry → reuse (same worktree, same anchor, every run).
 *   - otherwise → auto-pick the next free block and persist it.
 * Serialized by the lockfile so two `pnpm dev` launched at the same instant
 * never race into the same anchor.
 * @param {{ key: string, explicitAnchor?: number, registryPath?: string, lockPath?: string, isRangeFree?: (anchor: number) => Promise<boolean>, autoStart?: number, stride?: number }} params
 * @returns {Promise<{ anchor: number, source: 'main' | 'explicit' | 'existing' | 'auto', registry: Record<string, number> }>}
 */
export async function allocateAnchor(params) {
  const {
    key,
    explicitAnchor,
    registryPath = DEFAULT_REGISTRY_PATH,
    lockPath = DEFAULT_LOCK_PATH,
    isRangeFree = isAnchorBlockFree,
    autoStart = AUTO_START_ANCHOR,
    stride = STRIDE,
  } = params
  if (!key) throw new Error('dev-ports: key is required')
  if (explicitAnchor !== undefined && (!Number.isInteger(explicitAnchor) || explicitAnchor <= 0)) {
    throw new Error(`dev-ports: --anchor must be a positive integer, got ${explicitAnchor}`)
  }

  return withLock(lockPath, async () => {
    const registry = readRegistry(registryPath)
    let anchor
    let source
    if (key === MAIN_KEY && explicitAnchor === undefined) {
      anchor = MAIN_ANCHOR
      source = 'main'
    } else if (explicitAnchor !== undefined) {
      anchor = explicitAnchor
      source = 'explicit'
    } else if (registry[key] !== undefined) {
      anchor = registry[key]
      source = 'existing'
    } else {
      const used = new Set(Object.values(registry))
      anchor = await pickNextAnchor({ used, start: autoStart, stride, isRangeFree })
      source = 'auto'
    }
    if (registry[key] !== anchor) {
      registry[key] = anchor
      writeRegistry(registry, registryPath)
    }
    return { anchor, source, registry }
  })
}

/**
 * Drop registry entries whose key has no corresponding live worktree (§6
 * stale GC — a `gw end`ed worktree must not linger in the portal forever).
 * Pure: the caller (`scripts/dev-portal/`) supplies the live key set from
 * `git worktree list` and re-persists the result under the lock.
 * @param {Record<string, number>} registry
 * @param {Iterable<string>} liveKeys
 * @returns {Record<string, number>}
 */
export function pruneRegistry(registry, liveKeys) {
  const live = new Set(liveKeys)
  return Object.fromEntries(Object.entries(registry).filter(([key]) => live.has(key)))
}

// ── opt-in mongo DB isolation (§3 — mongo only; redis/ES stay shared) ──

/**
 * `dev.local.json` at the worktree root (gitignored) declares this
 * worktree's opt-in DB isolation. Missing/unreadable/malformed → not
 * isolated (fail safe towards the shared DB default, matching the rest of
 * the repo's tolerant-JSON-read style).
 * @param {string} worktreeDir
 * @returns {{ isolateDb: boolean }}
 */
export function readDevLocalConfig(worktreeDir) {
  try {
    const raw = fs.readFileSync(path.join(worktreeDir, 'dev.local.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return { isolateDb: parsed?.isolateDb === true }
  } catch {
    return { isolateDb: false }
  }
}

/**
 * Rewrite a single-host `mongodb://` (or `mongodb+srv://`) URI's database
 * name, keeping the authority (auth/host/port) and query string intact.
 * Dev-only helper for the shared local mongo instance — not a general
 * connection-string parser (multi-host replica-set URIs are out of scope;
 * infra stays a single shared instance per spec).
 * @param {string} mongoUri
 * @param {string} dbName
 * @returns {string}
 */
export function withMongoDbName(mongoUri, dbName) {
  const m = mongoUri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/)
  if (!m) throw new Error(`dev-ports: cannot parse MONGO_URI to rewrite its db name: ${mongoUri}`)
  const [, authority, query] = m
  return `${authority}/${dbName}${query ?? ''}`
}

/** The isolated db name for a worktree key, e.g. `feature-x` → `crowi_feature-x`. */
export function isolatedDbName(key) {
  return `crowi_${key}`
}

// ── tiny `.env` reader (no dotenv dep here; dev.mjs/migrate.mjs need exactly
// one key out of the repo-root `.env`, not full dotenv semantics) ──

/**
 * Extract `KEY=value` from a dotenv-style file. Ignores comments/blank lines,
 * strips a single layer of matching quotes. Returns `undefined` when the file
 * or key is missing.
 * @param {string} envFilePath
 * @param {string} key
 * @returns {string | undefined}
 */
export function readEnvFileValue(envFilePath, key) {
  let raw
  try {
    raw = fs.readFileSync(envFilePath, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const k = trimmed.slice(0, eq).trim()
    if (k !== key) continue
    let v = trimmed.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v
  }
  return undefined
}

/**
 * Resolve the base `MONGO_URI` used to derive a worktree's isolated db name
 * (`withMongoDbName`): an explicit env var wins, else the given `.env` file,
 * else the local default. Shared by `dev.mjs` and `migrate.mjs` so both
 * derive an isolated worktree's db from the same base URI.
 * @param {string} envFilePath
 * @returns {string}
 */
export function resolveBaseMongoUri(envFilePath) {
  return process.env.MONGO_URI || readEnvFileValue(envFilePath, 'MONGO_URI') || 'mongodb://localhost:27017/crowi'
}

// ── ALLOWED_DEV_ORIGINS (§3 — load-bearing for HMR WS Origin gate too) ──

/**
 * Build the comma-separated `ALLOWED_DEV_ORIGINS` value: `localhost` (the
 * proxy→web hop is same-host-different-port, which Next's `allowedDevOrigins`
 * treats as cross-origin — see `resolve-ws-url.ts` doc comment) plus the
 * tailscale hostname when resolved, de-duplicated.
 * @param {{ tailscaleHost?: string | null, extra?: string[] }} [opts]
 * @returns {string}
 */
export function buildAllowedDevOrigins(opts = {}) {
  const { tailscaleHost, extra = ['localhost', '127.0.0.1'] } = opts
  const hosts = [...extra, tailscaleHost].filter((h) => typeof h === 'string' && h.length > 0)
  return [...new Set(hosts)].join(',')
}

/**
 * Parse `tailscale status --json` output for this machine's tailnet
 * hostname (`Self.DNSName`, minus the trailing dot). Pure — the actual
 * `execFileSync` call lives in the launcher so it can warn+continue when the
 * `tailscale` binary is missing/not logged in.
 * @param {string} statusJson
 * @returns {string | null}
 */
export function parseTailscaleHostname(statusJson) {
  try {
    const parsed = JSON.parse(statusJson)
    const dnsName = parsed?.Self?.DNSName
    if (typeof dnsName !== 'string' || dnsName.length === 0) return null
    return dnsName.replace(/\.$/, '')
  } catch {
    return null
  }
}

/**
 * Best-effort `tailscale status --json` → hostname. Never throws: missing
 * binary / not logged in / any failure resolves to `null` (spec: warn +
 * continue, tailscale is optional for localhost-only dev).
 * @returns {string | null}
 */
export function resolveTailscaleHostname() {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return parseTailscaleHostname(out)
  } catch {
    return null
  }
}
