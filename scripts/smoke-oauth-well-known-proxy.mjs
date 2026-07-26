#!/usr/bin/env node
// Self-host smoke test for feature-oauth-discovery-proxy-fix.
//
// Reproduces the exact self-host topology from the bug report end to end,
// using the REAL committed artifacts (not a simulation of them):
//   - the actual `@crowi/web` `output: 'standalone'` production build
//     (`packages/web/.next/standalone/packages/web/server.js`)
//   - the actual repo-root `Caddyfile`, unmodified except for substituting
//     the docker-compose service names (`api:3000` / `web:3000`) with
//     `127.0.0.1:<port>` so it can run against local processes instead of
//     containers
//   - a throwaway fake api process standing in for `@crowi/api`, which only
//     needs to answer the discovery path for this test
//
// It asserts every part of the regression this fixed:
//   1. the built PHASE_PRODUCTION_BUILD `routes-manifest.json` (both the
//      top-level copy and the one actually shipped inside
//      `.next/standalone/`) contains no `.well-known/oauth-authorization-
//      server` rewrite — i.e. no environment-dependent absolute URL got
//      baked into the image (defect A, AC2).
//   2. hitting the standalone web server DIRECTLY (bypassing the front
//      proxy) on that path does not 500 — before this fix it did (the
//      baked rewrite pointed at `localhost:4301`, which nothing listens on
//      in a production container, so Next surfaced an ECONNREFUSED as a
//      500). Now there is no rewrite for that phase, so web just falls
//      through to its normal catch-all page routing (`[[...slug]]` treats
//      the path as a wiki page slug — observed as a 200 HTML shell, never
//      a 500) instead of proxying anywhere.
//   3. hitting the SAME path through the real Caddyfile (front proxy) gets
//      routed to the api and returns 200 with the api's discovery document
//      — end-to-end proof that defect B (the missing `/.well-known/*`
//      matcher) is fixed and the two fixes compose correctly (AC1).
//   4. a negative control: the SAME real standalone build behind a Caddyfile
//      rendered with the PRE-FIX `@api` matcher (no `/.well-known/*`) does
//      NOT reach the api — proving this smoke test actually exercises the
//      Caddyfile fix rather than passing for an unrelated reason.
//
// Usage: `pnpm --filter @crowi/web build` first (or `pnpm build` from repo
// root), then `pnpm smoke:oauth-well-known` (or `node
// scripts/smoke-oauth-well-known-proxy.mjs` directly). Requires the `caddy`
// binary on PATH. This is a manual/CI-optional verification tool, not part
// of `pnpm test` — it needs a prior production build and spins up real
// processes/ports, so it is intentionally NOT named `*.test.mjs` (that glob
// is picked up by `pnpm test:scripts`).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCaddyAvailable, startCaddyProcess, writeCaddyConfig } from './dev-caddy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const webDir = path.join(repoRoot, 'packages/web')
const manifestTop = path.join(webDir, '.next/routes-manifest.json')
const manifestStandalone = path.join(webDir, '.next/standalone/packages/web/.next/routes-manifest.json')
const standaloneServerDir = path.join(webDir, '.next/standalone/packages/web')
const caddyfileSrc = path.join(repoRoot, 'Caddyfile')

const WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server'
const results = []

function record(name, pass, detail) {
  results.push({ name, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await fetch(url)
    } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`)
}

async function main() {
  console.log('--- 1. manifest check (defect A / AC2): built production routes-manifest.json must not carry the .well-known rewrite ---')
  for (const [label, manifestPath] of [
    ['top-level .next/routes-manifest.json', manifestTop],
    ['.next/standalone/packages/web/.next/routes-manifest.json (the copy actually shipped in the image)', manifestStandalone],
  ]) {
    if (!fs.existsSync(manifestPath)) {
      record(`${label} exists`, false, `not found at ${manifestPath} — run \`pnpm --filter @crowi/web build\` first`)
      continue
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const afterFiles = manifest.rewrites?.afterFiles ?? (Array.isArray(manifest.rewrites) ? manifest.rewrites : [])
    const wellKnown = afterFiles.find((r) => r.source === WELL_KNOWN_PATH)
    record(`${label}: no baked .well-known rewrite`, !wellKnown, wellKnown ? `found destination=${wellKnown.destination}` : 'absent (expected)')
    const apiRewrite = afterFiles.find((r) => r.source === '/api/v2/:path*')
    record(`${label}: /api/v2 rewrite still present (unaffected by this fix)`, Boolean(apiRewrite), apiRewrite?.destination)
  }

  if (!fs.existsSync(path.join(standaloneServerDir, 'server.js'))) {
    record('standalone server.js exists', false, `not found under ${standaloneServerDir} — run \`pnpm --filter @crowi/web build\` first`)
    printSummaryAndExit()
    return
  }

  if (!isCaddyAvailable()) {
    record('caddy binary available on PATH', false, 'install caddy to run the front-proxy portion of this smoke test')
    printSummaryAndExit()
    return
  }

  const [apiPort, webPort, proxyPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()])

  // Mirrors the real api's discoveryRoute (packages/api/src/hono/handlers/
  // oauth.ts), which derives every URL from the trusted request origin
  // (CLIENT_URL in production) rather than a fixed value — the metadata
  // mix-up defense (RFC 8414/9207) requires `issuer === the origin the
  // client actually dialed`. Deriving from the inbound `Host` header here
  // (instead of a static hostname) lets the through-proxy assertion below
  // prove that property end to end: Caddy forwards the client's original
  // Host unchanged, so if the response's issuer didn't match, that would
  // mean either Caddy rewrote the Host or the fake api ignored it — either
  // way a real regression this smoke test should catch.
  const buildDiscoveryDoc = (origin) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/v2/oauth/token`,
    from: 'fake-api',
  })

  console.log('\n--- 2. starting a fake api process (stands in for @crowi/api) ---')
  const fakeApi = http.createServer((req, res) => {
    if (req.url === WELL_KNOWN_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildDiscoveryDoc(`http://${req.headers.host}`)))
      return
    }
    res.writeHead(404)
    res.end('fake-api: not found')
  })
  await new Promise((resolve) => fakeApi.listen(apiPort, '127.0.0.1', resolve))
  console.log(`fake api listening on 127.0.0.1:${apiPort}`)

  console.log('\n--- 3. starting the real standalone web production server ---')
  const webProcess = spawn(process.execPath, ['server.js'], {
    cwd: standaloneServerDir,
    env: { ...process.env, PORT: String(webPort), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let webLog = ''
  webProcess.stdout.on('data', (d) => {
    webLog += d
  })
  webProcess.stderr.on('data', (d) => {
    webLog += d
  })

  let caddyProcess
  try {
    const directRes = await waitForHttp(`http://127.0.0.1:${webPort}${WELL_KNOWN_PATH}`)
    console.log(`web listening on 127.0.0.1:${webPort} (server log so far:\n${webLog}\n)`)

    console.log(`\n--- 4. direct-to-web request (bypassing the front proxy), GET ${WELL_KNOWN_PATH} ---`)
    record(
      'direct-to-web request does not 500 (defect A fixed: no baked ECONNREFUSED target)',
      directRes.status !== 500,
      `status=${directRes.status}`,
    )

    console.log('\n--- 5. rendering the REAL repo-root Caddyfile with api:3000/web:3000 substituted for local ports, starting caddy ---')
    const caddyfileTemplate = fs.readFileSync(caddyfileSrc, 'utf8')
    // The `http://` scheme prefix is required (not just `127.0.0.1:<port>`):
    // Caddy's automatic-HTTPS logic treats any site address with a host part
    // as a domain needing a certificate (even a bare IP), and issues a local
    // self-signed one — the plain-HTTP request below would then get a 400
    // "Client sent an HTTP request to an HTTPS server". The real Caddyfile's
    // `:80` form (no host) sidesteps this entirely (no identifiable host to
    // provision a cert for); `http://` is the equivalent explicit opt-out
    // once we need a host part to target a specific loopback port.
    const rendered = caddyfileTemplate
      .replace(':80 {', `http://127.0.0.1:${proxyPort} {`)
      .replaceAll('api:3000', `127.0.0.1:${apiPort}`)
      .replaceAll('web:3000', `127.0.0.1:${webPort}`)
    const configPath = writeCaddyConfig('smoke-oauth-well-known-proxy', rendered)
    console.log(`rendered Caddyfile written to ${configPath}:\n${rendered}`)

    caddyProcess = startCaddyProcess(configPath)
    let caddyLog = ''
    caddyProcess.stdout.on('data', (d) => {
      caddyLog += d
    })
    caddyProcess.stderr.on('data', (d) => {
      caddyLog += d
    })

    const proxyRes = await waitForHttp(`http://127.0.0.1:${proxyPort}${WELL_KNOWN_PATH}`)
    console.log(`caddy listening on 127.0.0.1:${proxyPort} (caddy log so far:\n${caddyLog}\n)`)

    console.log(`\n--- 6. through-the-front-proxy request (the actual self-host path), GET ${WELL_KNOWN_PATH} ---`)
    record('through-proxy request returns 200', proxyRes.status === 200, `status=${proxyRes.status}`)
    const body = await proxyRes.json().catch((err) => ({ __parseError: String(err) }))
    // The client dialed the proxy's own origin — per the mix-up defense,
    // `issuer` (and the endpoints derived from it) must equal exactly that,
    // not some other host. `expectedDoc` is what the fake api would only
    // produce if Caddy delivered the client's original Host header through
    // unaltered, so this also proves Caddy isn't rewriting Host on the way.
    const expectedDoc = buildDiscoveryDoc(`http://127.0.0.1:${proxyPort}`)
    record(
      "through-proxy response is the API's discovery document with issuer/endpoints matching the dialed origin (proves Caddy routed to api with Host intact, not web's catch-all)",
      body.issuer === expectedDoc.issuer &&
        body.authorization_endpoint === expectedDoc.authorization_endpoint &&
        body.token_endpoint === expectedDoc.token_endpoint &&
        body.from === expectedDoc.from,
      JSON.stringify(body),
    )

    console.log('\n--- 7. negative control: re-run step 6 against the PRE-FIX @api matcher (no /.well-known/*) ---')
    console.log('(this proves the smoke test above actually exercises the Caddyfile fix, not something incidental)')
    const preFixProxyPort = await getFreePort()
    const preFixRendered = rendered
      .replace('@api path /api/* /files/* /.well-known/*', '@api path /api/* /files/*')
      .replace(`127.0.0.1:${proxyPort} {`, `127.0.0.1:${preFixProxyPort} {`)
    const preFixConfigPath = writeCaddyConfig('smoke-oauth-well-known-proxy-prefix-control', preFixRendered)
    const preFixCaddy = startCaddyProcess(preFixConfigPath)
    try {
      const preFixRes = await waitForHttp(`http://127.0.0.1:${preFixProxyPort}${WELL_KNOWN_PATH}`)
      const preFixBody = await preFixRes.text()
      const wouldHaveRoutedToApi = (() => {
        try {
          return JSON.parse(preFixBody).from === 'fake-api'
        } catch {
          return false
        }
      })()
      record(
        'pre-fix matcher (without /.well-known/*) falls through to web, NOT api (reproduces defect B)',
        !wouldHaveRoutedToApi && preFixRes.status !== 500,
        `status=${preFixRes.status} body=${preFixBody.slice(0, 120)}`,
      )
    } finally {
      preFixCaddy.kill('SIGTERM')
    }
  } finally {
    console.log('\n--- cleanup ---')
    webProcess.kill('SIGTERM')
    if (caddyProcess) caddyProcess.kill('SIGTERM')
    await new Promise((resolve) => fakeApi.close(resolve))
    // give the child processes a moment to exit before the script itself
    // exits, so we don't leave orphaned listeners on the ports we picked.
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  printSummaryAndExit()
}

function printSummaryAndExit() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== smoke test summary: ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length > 0) {
    console.log('FAILED checks:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
    process.exitCode = 1
  } else {
    console.log('all checks passed — self-host proxy + standalone web + api compose correctly for OAuth discovery.')
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err)
  process.exitCode = 1
})
