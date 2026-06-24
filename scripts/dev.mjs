#!/usr/bin/env node
// Dev launcher for `pnpm dev` (feature-boot-progress-ui, Part 2).
//
// Wraps — never replaces — turbo. It spawns the same `turbo run dev --filter …`
// invocation that the legacy `dev` script used (so turbo keeps owning `^build`,
// watch and cache), then overlays a small zero-dep ANSI dashboard during the
// noisy boot phase only:
//
//   - api  readiness: the `@@crowi:ready api <url>` marker emitted by the api
//                     boot reporter (`packages/api/src/util/boot-reporter.ts`).
//   - web  readiness: an HTTP probe of :4302 (any HTTP response = listening),
//                     with ECONNREFUSED → backoff retries to absorb the
//                     pre-listen window.
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

import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'

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

const WEB_PROBE_URL = 'http://localhost:4302/'

// Known dev ports → human label, for a friendlier port-conflict message.
const PORT_LABELS = { 4301: 'api', 4302: 'web', 4303: 'site' }

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

function main() {
  const isTTY = Boolean(process.stdout.isTTY)

  /** @type {{ api: boolean, web: boolean, deps: boolean }} */
  const ready = { api: false, web: false, deps: false }
  let apiUrl = 'http://localhost:4301'
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
    env: { ...colorEnv, ...process.env },
  })

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
      process.stdout.write(`\n${ANSI.bold}${ANSI.green}🚀 Accepting requests${ANSI.reset}  web ${WEB_PROBE_URL}\n\n`)
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
    process.stderr.write(`\n[dev] failed to start turbo: ${err.message}\n`)
    process.exit(1)
  })
}
