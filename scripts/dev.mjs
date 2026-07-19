#!/usr/bin/env node
// Dev launcher for `pnpm dev` (feature-boot-progress-ui, Part 2;
// feature-dev-portal-worktree extends it with per-worktree ports + proxy).
//
// Wraps — never replaces — turbo. It spawns the same `turbo run dev --filter …`
// invocation that the legacy `dev` script used (so turbo keeps owning `^build`,
// watch and cache), then overlays a small zero-dep ANSI dashboard during the
// noisy boot phase only:
//
//   - api  readiness: the `@@crowi:ready api <url>` marker emitted by the api
//                     boot reporter (`packages/api/src/util/boot-reporter.ts`).
//   - web  readiness: an HTTP probe of the web dev port (any HTTP response =
//                     listening), with ECONNREFUSED → backoff retries to
//                     absorb the pre-listen window.
//   - deps readiness: derived — once the api marker lands, the `^build` watch
//                     group (api-contract / collab / runner / plugins) must have
//                     finished its first compile, so we mark it ✓ then (we never
//                     parse turbo's build log format).
//
// Once api + web are both ready it prints `🚀 Accepting requests`, freezes the
// dashboard as a summary, and from then on simply passes turbo's stream
// through (no persistent sticky — request/HMR logs scroll normally).
//
// SIGINT/SIGTERM is forwarded to the turbo child (own process group) so the
// whole tree — turbo → api/web/plugins — stops cleanly with no zombies.
//
// feature-dev-portal-worktree adds, ahead of the turbo spawn:
//   1. worktree detection → normalized registry key (`./dev-ports.mjs`).
//   2. anchor resolution/allocation (registry + lock, or `--anchor`).
//   3. opt-in mongo DB isolation (`dev.local.json` or `--isolate-db`).
//   4. env injection into the turbo child (PORT/PORT_WEB/PORT_SITE/
//      CROWI_API_URL/ALLOWED_DEV_ORIGINS — see turbo.json's
//      `globalPassThroughEnv`, which must allowlist these or turbo's strict
//      env mode silently strips them and every worktree collides on :4302).
// …and, once the turbo child is spawned (in parallel with its boot, not
// gated on api/web readiness — a reverse proxy tolerates its upstreams not
// being up yet):
//   5. same-origin proxy on anchor+3 (Caddy, or the zero-dep node fallback
//      from `./dev-caddy.mjs` when `caddy` isn't installed).
//   6. `tailscale serve` on the proxy port only (best-effort: warn+continue
//      when tailscale isn't installed/logged in).
// On SIGINT/SIGTERM (or a fatal boot failure) both are torn down: the proxy
// process/server is killed, and `tailscale serve --https=<proxy> off` scopes
// the teardown to exactly this worktree's port (`tailscale serve reset` is
// never used — that would take down every other worktree's proxy, and the
// portal, too).

import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  allocateAnchor,
  buildAllowedDevOrigins,
  isolatedDbName,
  isPortFree,
  localIpv4Origins,
  MAIN_KEY,
  normalizeWorktreeKey,
  portsForAnchor,
  readDevLocalConfig,
  readEnvFileValue,
  resolveDevClientUrl,
  resolveBaseMongoUri,
  resolveTailscaleHostname,
  shouldStartMainPortal,
  withMongoDbName,
} from './dev-ports.mjs'
import { generateCaddyfile, isCaddyAvailable, startCaddyProcess, startNodeProxyFallback, writeCaddyConfig } from './dev-caddy.mjs'

// ── shared contract with boot-reporter.ts ──
const READY_MARKER_PREFIX = '@@crowi:ready'
const FAIL_MARKER_PREFIX = '@@crowi:fail'

// Same filter list as the legacy root `dev` script. Kept here verbatim so the
// turbo orchestration (concurrency / filters) is unchanged.
// `--concurrency` MUST exceed the number of persistent `dev` tasks turbo runs
// (api/web/api-contract/collab/runner + every `@crowi/plugin-*`); turbo errors
// out otherwise. Kept above the plugin count with headroom so adding a plugin
// doesn't break `pnpm dev`.
const TURBO_ARGS = [
  'run',
  'dev',
  '--concurrency=30',
  '--filter',
  '@crowi/api',
  '--filter',
  '@crowi/web',
  '--filter',
  '@crowi/api-contract',
  '--filter',
  '@crowi/collab',
  '--filter',
  '@crowi/runner',
  '--filter',
  '@crowi/plugin-*',
]

// ── pure helpers (kept tiny + side-effect-free for reasoning/testing) ──

/**
 * Parse a `@@crowi:ready <service> <url>` marker out of an output line (turbo
 * prefixes it with e.g. `@crowi/api:dev: `). Mirrors `parseReadyMarker` in
 * boot-reporter.ts — scripts can't import the api package, so the prefix is
 * pinned by the shared constant above.
 * @param {string} line
 * @returns {{ service: string, url: string } | null}
 */
export function parseReadyMarker(line) {
  const idx = line.indexOf(READY_MARKER_PREFIX)
  if (idx === -1) return null
  const rest = line.slice(idx + READY_MARKER_PREFIX.length).trim()
  const [service, url] = rest.split(/\s+/)
  if (!service || !url) return null
  return { service, url }
}

/**
 * Parse a `@@crowi:fail <service> <reason…>` marker (emitted by the api boot
 * reporter on a fatal boot error, e.g. the database is unreachable). `service`
 * is the first token; `reason` is the remainder (may be empty). Mirrors
 * `parseFailMarker` in boot-reporter.ts.
 * @param {string} line
 * @returns {{ service: string, reason: string } | null}
 */
export function parseFailMarker(line) {
  const idx = line.indexOf(FAIL_MARKER_PREFIX)
  if (idx === -1) return null
  const rest = line.slice(idx + FAIL_MARKER_PREFIX.length).trim()
  if (!rest) return null
  const sp = rest.indexOf(' ')
  if (sp === -1) return { service: rest, reason: '' }
  return { service: rest.slice(0, sp), reason: rest.slice(sp + 1).trim() }
}

/**
 * Detect an `EADDRINUSE` (port-already-in-use) error in an output line and
 * return the conflicting port number, or null. Matches node's
 * `listen EADDRINUSE: address already in use :::4302` and similar shapes —
 * the first digit run after `EADDRINUSE` is the port.
 * @param {string} line
 * @returns {number | null}
 */
export function parsePortConflict(line) {
  const m = line.match(/EADDRINUSE\D*(\d{2,5})/)
  return m ? Number(m[1]) : null
}

/**
 * Best-effort: PIDs currently holding a TCP port, via `lsof`. Returns [] when
 * lsof is missing or finds nothing (so the conflict message degrades to just
 * the copy-paste kill command). Synchronous — only ever called on the failure
 * path, once.
 * @param {number} port
 * @returns {string[]}
 */
export function lsofPids(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Exponential backoff with a ceiling, for the web probe retry loop.
 * @param {number} attempt 0-based retry count
 * @param {number} [base]
 * @param {number} [max]
 * @returns {number} delay in ms
 */
export function backoffDelay(attempt, base = 250, max = 2000) {
  return Math.min(base * 2 ** attempt, max)
}

/**
 * Render one dashboard service row. Pure so it can be unit-checked.
 * @param {string} label
 * @param {'pending' | 'ready'} state
 * @param {string} [detail]
 * @returns {string}
 */
export function renderRow(label, state, detail = '') {
  const icon = state === 'ready' ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.cyan}…${ANSI.reset}`
  const tail = detail ? `  ${ANSI.dim}${detail}${ANSI.reset}` : ''
  return `  ${icon} ${label.padEnd(6)}${tail}`
}

/**
 * Parse `pnpm dev`'s own CLI flags: `--anchor <n>` (pin the port block) and
 * `--isolate-db` (opt-in mongo DB isolation, in addition to `dev.local.json`).
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ anchor: number | undefined, isolateDb: boolean }}
 */
export function parseDevCliArgs(argv) {
  let anchor
  let isolateDb = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--anchor') {
      const raw = argv[i + 1]
      i += 1
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--anchor must be a positive integer, got ${JSON.stringify(raw)}`)
      }
      anchor = parsed
    } else if (arg === '--isolate-db') {
      isolateDb = true
    }
  }
  return { anchor, isolateDb }
}

const ANSI = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  cursorUp: (n) => `\x1b[${n}A`,
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}

// `import.meta.main` is Node 24+. Guard so the module can be imported by a test
// without spawning turbo.
if (import.meta.main) {
  main()
}

async function main() {
  const isTTY = Boolean(process.stdout.isTTY)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const key = normalizeWorktreeKey(repoRoot)

  let cli
  try {
    cli = parseDevCliArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[dev] ${err.message}\n`)
    process.exit(1)
    return
  }

  let anchor
  try {
    ;({ anchor } = await allocateAnchor({ key, explicitAnchor: cli.anchor }))
  } catch (err) {
    process.stderr.write(`[dev] failed to allocate a dev port anchor: ${err.message}\n`)
    process.exit(1)
    return
  }
  const ports = portsForAnchor(anchor)
  const WEB_PROBE_URL = `http://localhost:${ports.web}/`
  const PROXY_URL = `http://localhost:${ports.proxy}/`
  // Known dev ports → human label, for a friendlier port-conflict message.
  const PORT_LABELS = { [ports.api]: 'api', [ports.web]: 'web', [ports.site]: 'site', [ports.proxy]: 'proxy' }

  const isolateDb = cli.isolateDb || readDevLocalConfig(repoRoot).isolateDb
  let isolatedMongoUri
  if (isolateDb) {
    const baseMongoUri = resolveBaseMongoUri(path.join(repoRoot, '.env'))
    try {
      isolatedMongoUri = withMongoDbName(baseMongoUri, isolatedDbName(key))
    } catch (err) {
      process.stdout.write(`[dev] warning: could not derive an isolated MONGO_URI (${err.message}) — using the shared DB instead.\n`)
    }
  }

  // Load-bearing (§3): without the accessing host in ALLOWED_DEV_ORIGINS, both
  // Next's dev-asset gate AND the Turbopack HMR websocket's Origin check
  // silently reject it. We MERGE (never replace) so we don't clobber whatever
  // the developer already put in packages/web/.env.local — turbo now passes
  // ALLOWED_DEV_ORIGINS through, and Next won't let a .env file override an
  // already-set process.env var, so injecting a bare list here used to shadow
  // the user's value and block their tailscale/LAN IP. `localIpv4Origins()`
  // inside buildAllowedDevOrigins adds this machine's own IPs (Model B), so
  // http://<ip>:<port> access works even without the `tailscale` CLI.
  const tailscaleHost = resolveTailscaleHostname()
  if (!tailscaleHost) {
    process.stdout.write('[dev] tailscale CLI not detected — proxy is still reachable over localhost + this host’s LAN/tailscale IPs.\n')
  }
  const existingAllowed = [process.env.ALLOWED_DEV_ORIGINS, readEnvFileValue(path.join(repoRoot, 'packages', 'web', '.env.local'), 'ALLOWED_DEV_ORIGINS')]
    .filter(Boolean)
    .join(',')
  const allowedDevOrigins = buildAllowedDevOrigins({ tailscaleHost, existing: existingAllowed })

  const childEnvOverlay = {
    PORT: String(ports.api),
    PORT_WEB: String(ports.web),
    PORT_SITE: String(ports.site),
    // Next rewrites() target; the proxy (Caddy) takes /api first in practice,
    // this keeps direct-web-port access working too.
    CROWI_API_URL: `http://localhost:${ports.api}`,
    // OAuth issuer / CORS origin. Set in the overlay (which beats the api
    // child's --env-file read) so the per-worktree proxy origin applies;
    // resolveDevClientUrl keeps explicit process-env / .env values winning.
    CLIENT_URL: resolveDevClientUrl({
      processEnvValue: process.env.CLIENT_URL,
      envFileValue: readEnvFileValue(path.join(repoRoot, '.env'), 'CLIENT_URL'),
      proxyPort: ports.proxy,
    }),
    ALLOWED_DEV_ORIGINS: allowedDevOrigins,
    ...(isolatedMongoUri ? { MONGO_URI: isolatedMongoUri } : {}),
  }

  process.stdout.write(
    `[dev] worktree "${key}" → anchor ${anchor} (api ${ports.api} · web ${ports.web} · site ${ports.site} · proxy ${ports.proxy})` +
      `${isolateDb ? ` · db isolated (${isolatedDbName(key)})` : ' · db shared (main)'}\n`,
  )

  /** @type {{ api: boolean, web: boolean, deps: boolean }} */
  const ready = { api: false, web: false, deps: false }
  let apiUrl = `http://localhost:${ports.api}`
  let phase = 'boot' // 'boot' → overlay dashboard; 'stream' → passthrough
  let dashboardLines = 0
  let bootFailed = false

  // Drop the forced DEBUG flood: the api boot reporter is debug-independent, so
  // the default dev experience is the dashboard, not crowi:* debug spam.
  // Developers opt in by exporting DEBUG themselves before `pnpm dev`.
  //
  // Force colors on in the child when we're attached to a TTY: the child's
  // stdout/stderr are pipes (we forward them to this terminal verbatim), so
  // `debug` (DEBUG_COLORS) and turbo / chalk (FORCE_COLOR) would otherwise
  // auto-disable ANSI on the non-TTY pipe and `debug()` output would lose its
  // colors. `...process.env` last so a developer's own FORCE_COLOR /
  // DEBUG_COLORS wins, and we stay plain when output is redirected (no TTY).
  const colorEnv = isTTY ? { FORCE_COLOR: '1', DEBUG_COLORS: '1' } : {}
  const child = spawn('pnpm', ['exec', 'turbo', ...TURBO_ARGS], {
    stdio: ['inherit', 'pipe', 'pipe'],
    // Own process group so SIGINT can be delivered to the whole turbo tree.
    detached: true,
    env: { ...colorEnv, ...process.env, ...childEnvOverlay },
  })

  // ── same-origin proxy (§4) + tailscale serve (§7) ──
  // Started in parallel with turbo's boot (not gated on api/web readiness) —
  // a reverse proxy tolerates its upstreams not being up yet.
  let proxyChild = null // Caddy ChildProcess
  let proxyServer = null // node fallback http.Server
  let tailscaleServeOn = false
  let portalChild = null // shared dev portal (:4300) — main worktree only

  const startProxy = () => {
    if (isCaddyAvailable()) {
      const configPath = writeCaddyConfig(key, generateCaddyfile({ apiPort: ports.api, webPort: ports.web, proxyPort: ports.proxy }))
      proxyChild = startCaddyProcess(configPath)
      proxyChild.stderr?.on('data', (d) => process.stderr.write(`[caddy] ${d}`))
      proxyChild.on('error', (err) => {
        process.stdout.write(`[dev] warning: caddy failed to start (${err.message}) — proxy (anchor+3) unavailable this run.\n`)
        proxyChild = null
      })
      proxyChild.on('exit', (code, signal) => {
        if (!bootFailed && code !== null && code !== 0) {
          process.stdout.write(`[dev] warning: caddy exited early (code ${code}${signal ? `, signal ${signal}` : ''}).\n`)
        }
        proxyChild = null
      })
    } else {
      process.stdout.write('[dev] caddy not found on PATH — falling back to the zero-dep node proxy.\n')
      try {
        proxyServer = startNodeProxyFallback({ apiPort: ports.api, webPort: ports.web, proxyPort: ports.proxy })
        proxyServer.on('error', (err) => {
          const port = err.code === 'EADDRINUSE' ? ports.proxy : null
          if (port) reportPortConflict(port)
          else process.stdout.write(`[dev] warning: fallback proxy error (${err.message}).\n`)
          proxyServer = null
        })
      } catch (err) {
        process.stdout.write(`[dev] warning: failed to start the fallback proxy (${err.message}) — proxy (anchor+3) unavailable this run.\n`)
      }
    }
  }
  startProxy()

  const startTailscaleServe = () => {
    if (!tailscaleHost) return // already warned above
    try {
      execFileSync('tailscale', ['serve', '--bg', `--https=${ports.proxy}`, `localhost:${ports.proxy}`], { stdio: 'ignore' })
      tailscaleServeOn = true
    } catch (err) {
      process.stdout.write(`[dev] warning: \`tailscale serve\` failed to start (${err.message}) — localhost proxy still works.\n`)
    }
  }
  startTailscaleServe()

  // Shared dev portal (:4300): only the MAIN worktree's `pnpm dev` starts it —
  // it's the always-around home base, so feature worktrees just register into
  // the shared registry the portal reads and a feature restart never takes the
  // portal down. Leaves an already-running portal alone (e.g. a standalone
  // `pnpm dev:portal`); opt out with CROWI_DEV_NO_PORTAL=1.
  const PORTAL_PORT = 4300
  const startPortal = async () => {
    if (!shouldStartMainPortal(key)) return
    if (!(await isPortFree(PORTAL_PORT))) {
      process.stdout.write(`[dev] dev portal already running on :${PORTAL_PORT} — leaving it.\n`)
      return
    }
    const portalScript = path.join(repoRoot, 'scripts', 'dev-portal', 'index.mjs')
    portalChild = spawn(process.execPath, [portalScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    portalChild.stdout?.on('data', (d) => process.stdout.write(`[portal] ${d}`))
    portalChild.stderr?.on('data', (d) => process.stderr.write(`[portal] ${d}`))
    portalChild.on('error', (err) => {
      process.stdout.write(`[dev] warning: dev portal failed to start (${err.message}).\n`)
      portalChild = null
    })
    portalChild.on('exit', (code) => {
      if (!bootFailed && code) process.stdout.write(`[dev] dev portal exited (code ${code}).\n`)
      portalChild = null
    })
  }
  // NB: `startPortal()` is invoked at the very END of main() (after every turbo
  // child handler is wired) — its awaited port probe must not yield the event
  // loop before `child`'s 'exit'/'error' handlers exist.

  // Scoped to exactly this worktree's proxy port — never `tailscale serve
  // reset` (that would also drop every other worktree's proxy and the
  // portal's own serve).
  const stopProxyAndTailscale = () => {
    if (tailscaleServeOn) {
      try {
        execFileSync('tailscale', ['serve', `--https=${ports.proxy}`, 'off'], { stdio: 'ignore' })
      } catch {
        /* best-effort teardown; nothing more we can do here */
      }
      tailscaleServeOn = false
    }
    if (proxyChild) {
      try {
        proxyChild.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      proxyChild = null
    }
    if (proxyServer) {
      try {
        proxyServer.close()
        proxyServer.closeAllConnections?.()
      } catch {
        /* already closed */
      }
      proxyServer = null
    }
    if (portalChild) {
      try {
        portalChild.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      portalChild = null
    }
  }

  const clearDashboard = () => {
    if (!isTTY || dashboardLines === 0) return
    process.stdout.write(ANSI.cursorUp(dashboardLines) + ANSI.clearLine)
    for (let i = 1; i < dashboardLines; i++) {
      process.stdout.write(`\n${ANSI.clearLine}`)
    }
    process.stdout.write(ANSI.cursorUp(dashboardLines - 1 > 0 ? dashboardLines - 1 : 0))
    dashboardLines = 0
  }

  const drawDashboard = () => {
    if (!isTTY || phase !== 'boot') return
    clearDashboard()
    const lines = [
      `${ANSI.bold}Crowi dev${ANSI.reset} ${ANSI.dim}(booting…)${ANSI.reset}`,
      renderRow('deps', ready.deps ? 'ready' : 'pending', ready.deps ? 'watch build ready' : 'building…'),
      renderRow('api', ready.api ? 'ready' : 'pending', ready.api ? apiUrl : 'starting…'),
      renderRow('web', ready.web ? 'ready' : 'pending', ready.web ? WEB_PROBE_URL : 'starting…'),
    ]
    process.stdout.write(ANSI.hideCursor + lines.join('\n') + '\n')
    dashboardLines = lines.length
  }

  const passthrough = (chunk) => {
    if (phase === 'boot' && isTTY) {
      // Re-draw the dashboard below freshly-streamed boot logs.
      clearDashboard()
      process.stdout.write(chunk)
      drawDashboard()
    } else {
      process.stdout.write(chunk)
    }
  }

  const maybeAccepting = () => {
    if (ready.api && ready.web && phase === 'boot') {
      phase = 'stream'
      if (isTTY) {
        drawDashboard() // final render with both ✓
        process.stdout.write(ANSI.showCursor)
      }
      // The proxy (anchor+3) is the canonical dev entry point — collab /
      // presence / notifications only work same-origin through it (see
      // resolve-ws-url.ts). Direct web-port access still works for everything
      // except realtime. The proxy binds 0.0.0.0 (Model B), so it's also
      // reachable by IP from a phone / another device.
      const ipHosts = localIpv4Origins()
      const proxyIpUrls = ipHosts.map((ip) => `http://${ip}:${ports.proxy}/`)
      const tailscaleLine = tailscaleHost ? `  ·  tailscale https://${tailscaleHost}:${ports.proxy}/` : ''
      process.stdout.write(`\n${ANSI.bold}${ANSI.green}🚀 Accepting requests${ANSI.reset}  proxy ${PROXY_URL}${tailscaleLine}\n`)
      if (proxyIpUrls.length) {
        process.stdout.write(`${ANSI.dim}   reachable from another device: ${proxyIpUrls.join('  ')}${ANSI.reset}\n`)
      }
      // Portal note: the MAIN worktree's `pnpm dev` auto-starts the shared
      // portal; feature worktrees rely on main's (which survives their restarts).
      const portalHost = ipHosts[0] ?? 'localhost'
      let portalNote
      if (shouldStartMainPortal(key)) {
        portalNote = `dev portal: http://${portalHost}:4300  (auto-started with main)`
      } else if (key === MAIN_KEY) {
        // main, but CROWI_DEV_NO_PORTAL is set — don't tell them to re-run `pnpm dev`.
        portalNote = 'dev portal: off (CROWI_DEV_NO_PORTAL set) — run `pnpm dev:portal` to start it'
      } else {
        portalNote = `dev portal: http://${portalHost}:4300  (run \`pnpm dev\` in the main worktree, or \`pnpm dev:portal\`)`
      }
      process.stdout.write(`${ANSI.dim}   ${portalNote}${ANSI.reset}\n\n`)
      dashboardLines = 0 // freeze: from here on we passthrough
    }
  }

  const markApiReady = (url) => {
    if (ready.api) return
    ready.api = true
    apiUrl = url
    // api dev waits on `^build`, so its marker means the watch-build group has
    // produced a first compile — mark deps ✓ without parsing turbo's log.
    ready.deps = true
    drawDashboard()
    maybeAccepting()
  }

  // Print a fatal message, tear the whole turbo tree down, and exit non-zero.
  // Shared by the boot-failure and port-conflict paths. Idempotent: there's no
  // half-up state worth keeping (`tsx watch` survives an api crash and web
  // would keep serving against a dead api), so `pnpm dev` fails loudly and the
  // developer fixes the cause and re-runs.
  const teardown = (lines) => {
    if (bootFailed) return
    bootFailed = true
    if (isTTY) {
      clearDashboard()
      process.stdout.write(ANSI.showCursor)
    }
    process.stdout.write(`\n${lines.join('\n')}\n\n`)
    stopProxyAndTailscale()
    // Kill the whole turbo process group; child 'exit' then exits us non-zero.
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
    }
    // Backstop: if the tree doesn't exit promptly, force a non-zero exit.
    setTimeout(() => process.exit(1), 2000).unref()
  }

  // A dev port is already taken — almost always a stale `pnpm dev` left running
  // by parallel work / an agent. Show what's holding it and the exact command
  // to free it, then tear down so the developer can kill + re-run cleanly.
  const reportPortConflict = (port) => {
    if (bootFailed) return
    const label = PORT_LABELS[port] ? ` ${ANSI.dim}(${PORT_LABELS[port]})${ANSI.reset}` : ''
    const pids = lsofPids(port)
    const heldBy = pids.length ? `   ${ANSI.dim}held by PID ${pids.join(', ')}${ANSI.reset}` : ''
    teardown([
      `${ANSI.bold}${ANSI.red}✖ port ${port} already in use${ANSI.reset}${label}${heldBy}`,
      `  ${ANSI.dim}a stale dev server is holding it (parallel work / an agent?).${ANSI.reset}`,
      `  free it:     ${ANSI.bold}lsof -ti :${port} | xargs kill${ANSI.reset}  ${ANSI.dim}(add -9 if it persists)${ANSI.reset}`,
      `  then re-run: ${ANSI.bold}pnpm dev${ANSI.reset}`,
    ])
  }

  // Fatal api boot failure (e.g. database unreachable, or its own port taken).
  const failBoot = (service, reason) => {
    if (bootFailed) return
    const port = reason ? parsePortConflict(reason) : null
    if (port) {
      reportPortConflict(port)
      return
    }
    const why = reason ? `  ${ANSI.dim}${reason}${ANSI.reset}` : ''
    teardown([
      `${ANSI.bold}${ANSI.red}✖ ${service} failed to boot${ANSI.reset}${why}`,
      `${ANSI.dim}tearing down dev (api · web · deps)…${ANSI.reset}`,
    ])
  }

  // ── line-buffered stdout reader: detect the api marker, passthrough rest ──
  let stdoutBuf = ''
  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString()
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl + 1)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      const marker = parseReadyMarker(line)
      if (marker && marker.service === 'api') {
        // Don't echo the raw marker line (it's machine plumbing); show the
        // dashboard transition instead.
        markApiReady(marker.url)
        continue
      }
      const fail = parseFailMarker(line)
      if (fail && fail.service === 'api') {
        // Don't echo the raw marker; failBoot prints a human message and tears
        // the tree down.
        failBoot('api', fail.reason)
        continue
      }
      // Web (next) has no readiness marker — detect its raw EADDRINUSE here so
      // a port clash gets the same friendly "what's holding it / how to free
      // it" treatment instead of a bare stack trace.
      const port = parsePortConflict(line)
      if (port) {
        passthrough(line) // keep the original error visible above the hint
        reportPortConflict(port)
        continue
      }
      passthrough(line)
    }
  })
  child.stderr.on('data', (data) => {
    const s = data.toString()
    const port = parsePortConflict(s)
    if (port) reportPortConflict(port)
    passthrough(s)
  })

  // ── web readiness: HTTP probe with backoff (any response = listening) ──
  let webAttempt = 0
  const probeWeb = () => {
    if (ready.web) return
    const req = http.get(WEB_PROBE_URL, (res) => {
      res.resume() // drain
      ready.web = true
      drawDashboard()
      maybeAccepting()
    })
    req.setTimeout(2000, () => req.destroy(new Error('probe timeout')))
    req.on('error', () => {
      webAttempt += 1
      setTimeout(probeWeb, backoffDelay(webAttempt))
    })
  }
  // Kick off after a short grace so we don't burn the first few retries before
  // turbo has even forked next.
  setTimeout(probeWeb, 500)

  if (isTTY) drawDashboard()

  // ── signal propagation: forward to the turbo process group, then exit ──
  let forwarding = false
  const forward = (signal) => {
    if (forwarding) return
    forwarding = true
    if (isTTY) process.stdout.write(ANSI.showCursor)
    stopProxyAndTailscale()
    try {
      // Negative pid → deliver to the whole process group (turbo + children).
      process.kill(-child.pid, signal)
    } catch {
      // group gone already; fall back to direct child signal
      try {
        child.kill(signal)
      } catch {
        /* already dead */
      }
    }
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))

  child.on('exit', (code, signal) => {
    if (isTTY) process.stdout.write(ANSI.showCursor)
    stopProxyAndTailscale() // safety net in case turbo exited on its own
    // A fatal api boot failure tore the tree down on purpose — surface it as a
    // non-zero exit regardless of how turbo itself terminated.
    if (bootFailed) {
      process.exit(1)
    }
    if (signal) {
      process.exit(0)
    }
    process.exit(code ?? 0)
  })
  child.on('error', (err) => {
    if (isTTY) process.stdout.write(ANSI.showCursor)
    stopProxyAndTailscale()
    process.stderr.write(`\n[dev] failed to start turbo: ${err.message}\n`)
    process.exit(1)
  })

  // Portal last: every turbo-child handler above is now registered, so the
  // awaited port probe inside startPortal() can't open a window where a
  // fast-failing turbo's 'exit'/'error' event is missed or unhandled.
  await startPortal()
}
