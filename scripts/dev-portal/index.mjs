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
 * @param {Awaited<ReturnType<typeof buildPortalRows>>} rows
 */
export function renderPortalHtml(rows) {
  const body = rows.length
    ? rows
        .map((r) => {
          const status = r.anchor === null ? '⚪ not started' : r.up ? '🟢 up' : '🔴 down'
          const local = r.localUrl ? `<a href="${escapeHtml(r.localUrl)}">${escapeHtml(r.localUrl)}</a>` : '—'
          // Reachable-from-another-device URLs: this host's LAN/tailscale IPs
          // (proxy binds 0.0.0.0) plus the tailscale MagicDNS URL when the CLI
          // resolved one. Each is a link; joined so a phone can pick whichever
          // network it's on.
          const reachableUrls = [...(r.ipUrls ?? []), r.tailscaleUrl].filter(Boolean)
          const reachable = reachableUrls.length
            ? reachableUrls.map((u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join('<br>')
            : '—'
          return `      <tr>
        <td>${escapeHtml(r.key)}</td>
        <td>${escapeHtml(r.branch ?? '—')}</td>
        <td>${status}</td>
        <td>${local}</td>
        <td>${reachable}</td>
        <td>${escapeHtml(r.db)}</td>
      </tr>`
        })
        .join('\n')
    : '      <tr><td colspan="6">No worktrees found.</td></tr>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Crowi dev portal</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 1.5rem; background: #0b0d12; color: #e6e6e6; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #2a2e37; word-break: break-word; }
  th { color: #9aa4b2; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  a { color: #6ea8fe; }
  .note { color: #9aa4b2; font-size: 0.85rem; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Crowi dev portal</h1>
<table>
  <thead>
    <tr><th>worktree</th><th>branch</th><th>status</th><th>proxy (localhost)</th><th>proxy (reachable)</th><th>db</th></tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>
<p class="note">Refreshes every 10s. Operations (start/stop/restart) are out of scope — this is a read-only list.</p>
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
  server.listen(PORTAL_PORT, '0.0.0.0', () => {
    const reachable = [`http://localhost:${PORTAL_PORT}`, ...localIpv4Origins().map((ip) => `http://${ip}:${PORTAL_PORT}`)]
    process.stdout.write(`[dev-portal] listening on:\n${reachable.map((u) => `  ${u}`).join('\n')}\n`)
  })
  return server
}

if (import.meta.main) {
  startServer()
}
