#!/usr/bin/env node
// `pnpm dev:portal` — static dev portal (feature-dev-portal-worktree §6).
//
// Not a persistent build: on every request it re-reads the shared port
// registry (`~/.crowi-dev-ports.json`) + `git worktree list` + a quick TCP
// probe of each worktree's proxy port, renders one HTML page, and serves it.
// That's simpler than a background poll+cache loop and just as fresh (the
// page also carries a `<meta http-equiv="refresh">` so a phone tab left open
// keeps updating). No framework, no persistent state beyond the registry file
// every `pnpm dev` launcher already maintains.
//
// This process is deliberately separate from `pnpm dev` (own `pnpm dev:portal`
// script) — restarting one worktree's dev server must not take the portal
// down for every other worktree (spec §5 requirement 3: verify multiple
// worktrees from a phone without tearing any of them down to do it).
//
// Stale GC: a worktree removed via `gw end` (or plain `git worktree remove`)
// disappears from `git worktree list`; the registry entry for its key is then
// dropped here (under the shared lock) so it stops showing up — see
// `pruneRegistry` in `../dev-ports.mjs`.

import { execFileSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LOCK_PATH,
  DEFAULT_REGISTRY_PATH,
  isolatedDbName,
  localIpv4Origins,
  normalizeWorktreeKey,
  portsForAnchor,
  pruneRegistry,
  readDevLocalConfig,
  readRegistry,
  resolveTailscaleHostname,
  withLock,
  writeRegistry,
} from '../dev-ports.mjs'

export const PORTAL_PORT = 4300

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Parse `git worktree list --porcelain` into `[{ dir, branch }]`. Pure.
 * @param {string} porcelain
 * @returns {{ dir: string, branch: string | null }[]}
 */
export function parseWorktreeList(porcelain) {
  return porcelain
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const dirLine = lines.find((l) => l.startsWith('worktree '))
      const branchLine = lines.find((l) => l.startsWith('branch '))
      return {
        dir: dirLine ? dirLine.slice('worktree '.length) : null,
        branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
      }
    })
    .filter((w) => w.dir !== null)
}

function listLiveWorktrees() {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  return parseWorktreeList(out)
}

/** Quick TCP-connect probe (spec §6 default: "proxy port probe", not a boot marker). */
function probeProxyUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/**
 * Cross-reference the registry against live worktrees, GC stale entries, and
 * build one row per live worktree.
 * @returns {Promise<Array<{ key: string, branch: string | null, anchor: number | null, up: boolean, localUrl: string | null, ipUrls: string[], tailscaleUrl: string | null, db: string }>>}
 */
export async function buildPortalRows() {
  const worktrees = listLiveWorktrees()
  const liveKeys = worktrees.map((w) => normalizeWorktreeKey(w.dir))

  // Stale GC, under the same lock the launcher/dev-ports use.
  await withLock(DEFAULT_LOCK_PATH, () => {
    const registry = readRegistry(DEFAULT_REGISTRY_PATH)
    const pruned = pruneRegistry(registry, liveKeys)
    if (Object.keys(pruned).length !== Object.keys(registry).length) {
      writeRegistry(pruned, DEFAULT_REGISTRY_PATH)
    }
  })

  const registry = readRegistry(DEFAULT_REGISTRY_PATH)
  const tailscaleHost = resolveTailscaleHostname()
  // This host's own LAN/tailscale IPv4s — the proxy binds 0.0.0.0 (Model B), so
  // these are the URLs a phone/other machine actually dials.
  const ipHosts = localIpv4Origins()

  return Promise.all(
    worktrees.map(async (w) => {
      const key = normalizeWorktreeKey(w.dir)
      const anchor = registry[key]
      if (anchor === undefined) {
        // Registered as a worktree but `pnpm dev` hasn't run there yet.
        return { key, branch: w.branch, anchor: null, up: false, localUrl: null, ipUrls: [], tailscaleUrl: null, db: 'shared (main)' }
      }
      const { proxy } = portsForAnchor(anchor)
      const up = await probeProxyUp(proxy)
      const { isolateDb } = readDevLocalConfig(w.dir)
      return {
        key,
        branch: w.branch,
        anchor,
        up,
        localUrl: `http://localhost:${proxy}/`,
        ipUrls: ipHosts.map((ip) => `http://${ip}:${proxy}/`),
        tailscaleUrl: tailscaleHost ? `https://${tailscaleHost}:${proxy}/` : null,
        db: isolateDb ? isolatedDbName(key) : 'shared (main)',
      }
    }),
  ).then((rows) => rows.sort((a, b) => (a.key === 'main' ? -1 : b.key === 'main' ? 1 : a.key.localeCompare(b.key))))
}

/**
 * Render the single static HTML page. Pure given `rows`.
 *
 * A responsive **card** layout (one card per worktree), NOT a table: on a phone
 * a 6-column table crushed every URL into one-character-per-line columns. Each
 * card stacks full-width, and — since the portal is opened ON the phone —
 * the reachable IP/tailscale URLs (what actually works from another device) are
 * the prominent tap targets, with the localhost URL kept as a muted secondary
 * link (useful when viewing the portal on the host Mac itself).
 * @param {Awaited<ReturnType<typeof buildPortalRows>>} rows
 */
export function renderPortalHtml(rows) {
  const linkRow = (u, cls = '') => `<a class="link${cls ? ` ${cls}` : ''}" href="${escapeHtml(u)}">${escapeHtml(u)}</a>`

  const card = (r) => {
    const state = r.anchor === null ? 'idle' : r.up ? 'up' : 'down'
    const statusText = r.anchor === null ? '⚪ not started' : r.up ? '🟢 up' : '🔴 down'
    // Reachable-from-another-device URLs first (this host's LAN/tailscale IPs
    // + the tailscale MagicDNS URL), then localhost as a muted secondary link.
    const reachable = [...(r.ipUrls ?? []), r.tailscaleUrl].filter(Boolean)
    let links
    if (r.anchor === null) {
      links = '<p class="hint">Run <code>pnpm dev</code> in this worktree to start it.</p>'
    } else {
      const parts = reachable.map((u) => linkRow(u))
      if (r.localUrl) parts.push(linkRow(r.localUrl, 'local'))
      links = `<div class="links">${parts.join('')}</div>`
    }
    return `    <article class="wt">
      <div class="head">
        <div class="name"><span class="key">${escapeHtml(r.key)}</span><span class="branch">${escapeHtml(r.branch ?? '—')}</span></div>
        <span class="status ${state}">${statusText}</span>
      </div>
      <div class="meta"><span class="chip">db · ${escapeHtml(r.db)}</span>${r.anchor === null ? '' : `<span class="chip">anchor ${escapeHtml(String(r.anchor))}</span>`}</div>
      ${links}
    </article>`
  }

  const body = rows.length ? rows.map(card).join('\n') : '    <p class="empty">No worktrees found.</p>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Crowi dev portal</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, sans-serif;
    margin: 0; padding: 1rem 0.9rem 2rem;
    background: #0b0d12; color: #e6e6e6;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.2rem; margin: 0.25rem 0 0.15rem; }
  .sub { color: #8a93a2; font-size: 0.78rem; margin: 0 0 1.1rem; }
  .wt {
    background: #12151c; border: 1px solid #262b36; border-radius: 12px;
    padding: 0.85rem 0.9rem; margin-bottom: 0.7rem;
  }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem; }
  .name { min-width: 0; }
  .key { font-size: 1.02rem; font-weight: 700; overflow-wrap: anywhere; }
  .branch { display: block; color: #8a93a2; font-size: 0.78rem; margin-top: 0.1rem; overflow-wrap: anywhere; }
  .status { flex: none; font-size: 0.8rem; white-space: nowrap; }
  .status.up { color: #4ade80; }
  .status.down { color: #f87171; }
  .status.idle { color: #8a93a2; }
  .meta { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.6rem 0 0.15rem; }
  .chip {
    font-size: 0.72rem; color: #cbd3df; background: #1c2230;
    border: 1px solid #2a3140; border-radius: 999px; padding: 0.12rem 0.55rem;
  }
  .links { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.55rem; }
  .link {
    display: block; min-height: 44px; line-height: 1.35;
    padding: 0.62rem 0.7rem; border-radius: 9px;
    background: #17202e; border: 1px solid #223049;
    color: #7cb0ff; text-decoration: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88rem; overflow-wrap: anywhere;
  }
  .link:active { background: #1e2a3d; }
  .link.local {
    background: transparent; border-color: #232833; color: #7f8a99;
    min-height: 0; padding: 0.45rem 0.7rem; font-size: 0.8rem;
  }
  .hint { color: #8a93a2; font-size: 0.85rem; margin: 0.55rem 0 0; }
  code { background: #1c2230; border-radius: 5px; padding: 0.05rem 0.35rem; font-size: 0.85em; }
  .empty { color: #8a93a2; padding: 2.5rem 0; text-align: center; }
  .note { color: #6b7280; font-size: 0.75rem; margin-top: 1.1rem; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<h1>Crowi dev portal</h1>
<p class="sub">Tap a proxy URL to open that worktree. Auto-refreshes every 10s.</p>
${body}
<p class="note">Read-only list · start/stop is out of scope.</p>
</div>
</body>
</html>
`
}

function startServer() {
  const server = http.createServer(async (_req, res) => {
    try {
      const rows = await buildPortalRows()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPortalHtml(rows))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dev-portal: failed to build the worktree list: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  // Bind 0.0.0.0 (Model B) so the portal is reachable at
  // http://<lan-or-tailscale-ip>:4300 from a phone / another machine — no
  // tailscale CLI required. Dev-only; this also exposes it on the LAN, an
  // accepted tradeoff for the "verify from any device" workflow.
  // Fail gracefully if a portal is already up (e.g. the main worktree's
  // `pnpm dev` started one, and a standalone `pnpm dev:portal` is run too) —
  // no need for a stack trace, just step aside.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stdout.write(`[dev-portal] :${PORTAL_PORT} already in use — a portal is already running; leaving it.\n`)
      process.exit(0)
    }
    process.stderr.write(`[dev-portal] server error: ${err.message}\n`)
    process.exit(1)
  })
  server.listen(PORTAL_PORT, '0.0.0.0', () => {
    const reachable = [`http://localhost:${PORTAL_PORT}`, ...localIpv4Origins().map((ip) => `http://${ip}:${PORTAL_PORT}`)]
    process.stdout.write(`[dev-portal] listening on:\n${reachable.map((u) => `  ${u}`).join('\n')}\n`)
  })
  return server
}

if (import.meta.main) {
  startServer()
}
