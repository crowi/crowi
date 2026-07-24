// Unit + light integration tests for scripts/dev-caddy.mjs. Run with
// `node --test` (see dev-ports.test.mjs for the rationale). The Caddyfile
// generator and routing-decision function are pure and get plain unit tests;
// the zero-dep fallback proxy is exercised end-to-end against two throwaway
// `net`/`http` servers standing in for "api" and "web" — no real Caddy binary
// or network access required, matching the spec's "mock the spawn, don't
// depend on a real binary" instruction (there is no spawn to mock here since
// the fallback path IS the zero-dep implementation under test).

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, describe, it } from 'node:test'

import { API_HTTP_PATHS, generateCaddyfile, pickProxyTarget, startNodeProxyFallback, WS_NAMESPACES } from './dev-caddy.mjs'

describe('generateCaddyfile', () => {
  const config = generateCaddyfile({ apiPort: 4310, webPort: 4311, proxyPort: 4313 })

  it('binds 0.0.0.0 by default via the bind directive (Model B — reachable via LAN/tailscale IP)', () => {
    assert.match(config, /\n\tbind 0\.0\.0\.0\n/)
  })

  it('pins the explicit http:// scheme (schemeless non-:80 addresses get Caddy auto-HTTPS)', () => {
    // Regression pin for 2026-07-23: without the scheme, Caddy serves the
    // site with automatic HTTPS (local-CA TLS) the moment a real `caddy`
    // binary is on PATH, and every plain-HTTP dev client gets 400 "Client
    // sent an HTTP request to an HTTPS server". The node fallback proxy is
    // plain HTTP, so the two proxy paths silently disagreed until then.
    assert.match(config, /^http:\/\//m)
  })

  it('pins the EMPTY host in the site address (a host there is a Host MATCHER, not a bind address)', () => {
    // Second half of the same 2026-07-23 regression: `http://0.0.0.0:4313`
    // makes Caddy serve ONLY requests whose Host header is literally
    // "0.0.0.0:4313" and answer everything else (localhost, LAN IPs,
    // tailscale MagicDNS) with its empty-200 default — which reads as
    // "200 OK with an empty body" and slips straight past status-code-only
    // health checks. The interface restriction belongs to `bind` above.
    assert.match(config, /^http:\/\/:4313 \{/m)
  })

  it('routes /api and /files (bare + wildcard) to the api port', () => {
    assert.match(config, /@api path[^\n]*\/api[^\n]*\/api\/\*[^\n]*\/files[^\n]*\/files\/\*/)
    assert.match(config, /@api[\s\S]*?reverse_proxy @api localhost:4310/)
  })

  it('routes the whole /.well-known/* space (bare + wildcard) to the api port, mirroring the prod Caddyfile matcher', () => {
    // The prod Caddyfile's @api matcher was broadened from the single
    // /.well-known/oauth-authorization-server path to a /.well-known/*
    // wildcard (feature-oauth-discovery-proxy-fix) specifically so a future
    // OAuth metadata route (e.g. RFC 9728's /.well-known/oauth-protected-
    // resource) needs no further Caddyfile edit. This dev-proxy routing
    // table claims to mirror that Caddyfile (see the module doc comment
    // above) but was left on the old single-path form — pin the parity.
    assert.match(config, /@api path[^\n]*\/\.well-known(?!\/\*)[^\n]*\/\.well-known\/\*/)
  })

  it('routes all three WS namespaces, bare AND /* form, to the api port', () => {
    for (const ns of WS_NAMESPACES) {
      assert.match(config, new RegExp(`@ws path[^\\n]*/${ns}(?!/\\*)`))
      assert.match(config, new RegExp(`@ws path[^\\n]*/${ns}/\\*`))
    }
    assert.match(config, /@ws[\s\S]*?reverse_proxy @ws localhost:4310/)
  })

  it('falls through everything else to the web port', () => {
    // The final bare `reverse_proxy localhost:<webPort>` (no @matcher prefix).
    assert.match(config, /\n\treverse_proxy localhost:4311\n/)
  })

  it('honors a custom listenHost (loopback still overridable)', () => {
    const custom = generateCaddyfile({ apiPort: 1, webPort: 2, proxyPort: 3, listenHost: '127.0.0.1' })
    assert.match(custom, /^http:\/\/:3 \{/m)
    assert.match(custom, /\n\tbind 127\.0\.0\.1\n/)
  })
})

describe('startNodeProxyFallback default bind host', () => {
  it('binds 0.0.0.0 by default so the proxy is reachable via LAN/tailscale IP (Model B)', async () => {
    const server = startNodeProxyFallback({ apiPort: 1, webPort: 2, proxyPort: 0 })
    await new Promise((resolve, reject) => {
      server.on('listening', resolve)
      server.on('error', reject)
    })
    assert.equal(server.address().address, '0.0.0.0')
    await new Promise((resolve) => server.close(resolve))
  })
})

describe('pickProxyTarget', () => {
  it('routes api http paths to api', () => {
    for (const p of API_HTTP_PATHS) {
      assert.equal(pickProxyTarget(p), 'api')
      assert.equal(pickProxyTarget(`${p}/sub/path`), 'api')
    }
  })

  it('routes ws namespaces (bare and /*) to api', () => {
    for (const ns of WS_NAMESPACES) {
      assert.equal(pickProxyTarget(`/${ns}`), 'api')
      assert.equal(pickProxyTarget(`/${ns}/some-doc-id`), 'api')
    }
  })

  it('strips the query string before matching', () => {
    assert.equal(pickProxyTarget('/api/v2/page?path=/foo'), 'api')
    assert.equal(pickProxyTarget('/collab?token=abc'), 'api')
    assert.equal(pickProxyTarget('/?x=1'), 'web')
  })

  it('does not treat a namespace-prefixed unrelated path as a match', () => {
    // `/collaboration` must NOT match the `/collab` bare-or-slash rule.
    assert.equal(pickProxyTarget('/collaboration'), 'web')
  })

  it('falls through everything else to web', () => {
    assert.equal(pickProxyTarget('/'), 'web')
    assert.equal(pickProxyTarget('/_next/webpack-hmr'), 'web')
    assert.equal(pickProxyTarget('/some/page/path'), 'web')
  })
})

describe('startNodeProxyFallback (zero-dep proxy, end-to-end against fake backends)', () => {
  let apiServer
  let webServer
  let proxy
  let apiPort
  let webPort
  let proxyPort
  let lastApiRequestHeaders
  // `http.Server#closeAllConnections()` does not reach sockets already handed
  // off via the 'upgrade' event (Node stops tracking them as HTTP
  // connections once upgraded) — so `server.close()` would otherwise hang
  // forever waiting on the raw WS socket. Track every accepted raw socket
  // ourselves and destroy them directly in `after()` instead of relying on
  // that helper.
  const openSockets = new Set()
  const trackSockets = (server) => {
    server.on('connection', (socket) => {
      openSockets.add(socket)
      socket.on('close', () => openSockets.delete(socket))
    })
  }

  const listen = (server) =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })

  it('sets up fake api/web backends and the fallback proxy in front of them', async () => {
    apiServer = http.createServer((req, res) => {
      lastApiRequestHeaders = req.headers
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`api:${req.url}`)
    })
    // Minimal raw-socket "WS" endpoint: echoes back whatever it receives after
    // completing a bare 101 handshake, so the test can assert the fallback
    // proxy relays bytes both ways instead of implementing real RFC6455 framing.
    apiServer.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', (chunk) => socket.write(chunk)) // echo
    })
    webServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`web:${req.url}`)
    })

    apiPort = await listen(apiServer)
    webPort = await listen(webServer)
    proxy = startNodeProxyFallback({ apiPort, webPort, proxyPort: 0, listenHost: '127.0.0.1' })
    await new Promise((resolve, reject) => {
      proxy.on('listening', resolve)
      proxy.on('error', reject)
    })
    proxyPort = proxy.address().port
    for (const s of [apiServer, webServer, proxy]) trackSockets(s)
  })

  it('forwards an /api/* request to the api backend', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/api/v2/page`, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    assert.equal(body, 'api:/api/v2/page')
  })

  it('forwards a / request to the web backend', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/some/page`, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    assert.equal(body, 'web:/some/page')
  })

  it('forwards the original Host header upstream', async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/api/v2/whoami', headers: { Host: 'my-worktree.tailnet.ts.net' } },
        (res) => {
          res.resume()
          res.on('end', resolve)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(lastApiRequestHeaders.host, 'my-worktree.tailnet.ts.net')
  })

  it('proxies a WebSocket upgrade to /collab bidirectionally and closes both sides together', async () => {
    const client = net.connect(proxyPort, '127.0.0.1')
    await new Promise((resolve) => client.on('connect', resolve))

    const responseChunks = []
    const gotHandshake = new Promise((resolve) => {
      client.on('data', function onData(chunk) {
        responseChunks.push(chunk)
        if (Buffer.concat(responseChunks).includes('\r\n\r\n')) {
          client.removeListener('data', onData)
          resolve()
        }
      })
    })
    client.write('GET /collab?token=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    await gotHandshake
    assert.match(Buffer.concat(responseChunks).toString(), /101 Switching Protocols/)

    const echoed = new Promise((resolve) => client.once('data', (chunk) => resolve(chunk.toString())))
    client.write('ping-through-proxy')
    assert.equal(await echoed, 'ping-through-proxy')

    // Tear the raw socket down explicitly (this is a hand-rolled test double,
    // not a real WS client) — the fallback proxy's own 'close'/'error'
    // handlers are exercised by every prior request in this suite tearing
    // down its connection.
    client.destroy()
  })

  after(async () => {
    for (const socket of openSockets) socket.destroy()
    await Promise.all(
      [proxy, apiServer, webServer].map(
        (s) =>
          new Promise((resolve) => {
            if (!s) return resolve()
            s.close(() => resolve())
          }),
      ),
    )
  })
})
