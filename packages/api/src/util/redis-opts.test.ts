import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { createClient } from 'redis';
import { buildRedisOpts } from './redis-opts';

describe('buildRedisOpts', () => {
  it('returns null when no REDIS_URL is configured', () => {
    expect(buildRedisOpts(null, true)).toBeNull();
    expect(buildRedisOpts('', true)).toBeNull();
  });

  it('rediss:// produces the node-redis v4 TLS socket shape — `tls: true` LITERAL with the TLS options flattened beside it', () => {
    // node-redis v4 picks the TLS transport via a strict `options.tls === true`
    // check (@redis/client socket.js `#isTlsSocket`); its typed contract is
    // `RedisTlsSocketOptions extends tls.ConnectionOptions { tls: true }`.
    // A nested `tls: { ... }` OBJECT fails that strict check and silently
    // downgrades a rediss:// URL to a PLAINTEXT net socket — the bug this
    // pins against.
    expect(buildRedisOpts('rediss://localhost:6380', true)).toStrictEqual({
      socket: { host: 'localhost', port: 6380, tls: true, requestCert: true, rejectUnauthorized: true },
      database: 0,
    });
    expect(buildRedisOpts('rediss://localhost:6380', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6380, tls: true, requestCert: true, rejectUnauthorized: false },
      database: 0,
    });
  });

  it('redis://user:pass@host forwards BOTH the ACL username and password (decoded), matching collab parseRedisUrlForIoredis', () => {
    // node-redis v4 AUTHs with the top-level `username` option (ACL). The
    // old implementation kept only the password, so an ACL URL had the api
    // client authenticating as the `default` user while collab's ioredis
    // parser (extension-redis.ts) passed both — same URL, divergent auth.
    expect(buildRedisOpts('redis://app%40svc:p%40ss@localhost:6379', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
      username: 'app@svc',
      password: 'p@ss',
    });
  });

  it('redis://:pass@host (empty username) stays password-only; redis://user@host (no colon) is username-only', () => {
    expect(buildRedisOpts('redis://:secret@localhost:6379', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
      password: 'secret',
    });
    expect(buildRedisOpts('redis://onlyuser@localhost:6379', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
      username: 'onlyuser',
    });
  });

  it('decodes credentials exactly ONCE and keeps the user:pass boundary for encoded colons (legacy url.parse pre-decoded and broke both)', () => {
    // %2540 must decode to the literal '%40' (NOT '@' — that would be a
    // double decode), and an encoded ':' must stay inside the password.
    expect(buildRedisOpts('redis://acl:p%2540ss@localhost:6379', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
      username: 'acl',
      password: 'p%40ss',
    });
    expect(buildRedisOpts('redis://acl:pa%3Ass@localhost:6379', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
      username: 'acl',
      password: 'pa:ss',
    });
  });

  it('IPv6 literal hosts lose the WHATWG brackets (net/tls connect want the bare address)', () => {
    expect(buildRedisOpts('redis://[::1]:6379', false)).toStrictEqual({
      socket: { host: '::1', port: 6379 },
      database: 0,
    });
  });

  it('redis:// carries no tls key at all', () => {
    expect(buildRedisOpts('redis://localhost:6379', true)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
    });
  });

  it('a REDIS_URL database pathname (feature-redis-key-prefix §3) is parsed into the top-level `database` field', () => {
    expect(buildRedisOpts('redis://localhost:6379/0', true)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 0,
    });
    expect(buildRedisOpts('redis://localhost:6379/1', true)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
      database: 1,
    });
    expect(buildRedisOpts('rediss://ACL-user:password@host/1', true)).toStrictEqual({
      socket: { host: 'host', port: 6379, tls: true, requestCert: true, rejectUnauthorized: true },
      database: 1,
      username: 'ACL-user',
      password: 'password',
    });
  });

  it('an invalid REDIS_URL database pathname throws instead of silently connecting to DB 0 (mirrors collab parseRedisUrlForIoredis)', () => {
    expect(() => buildRedisOpts('redis://localhost:6379/foo', true)).toThrow(/database pathname/);
    expect(() => buildRedisOpts('redis://localhost:6379/-1', true)).toThrow(/database pathname/);
    expect(() => buildRedisOpts('redis://localhost:6379/1/extra', true)).toThrow(/database pathname/);
  });

  it('rediss:// performs an ACTUAL TLS handshake against the server (repro: the object-shaped `tls` selected a plaintext socket)', async () => {
    const server = tls.createServer({
      key: readFileSync(path.join(__dirname, '__fixtures__/tls/localhost-key.pem')),
      cert: readFileSync(path.join(__dirname, '__fixtures__/tls/localhost-cert.pem')),
    });
    const secureSeen = new Promise<void>((resolve) => server.once('secureConnection', () => resolve()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // 127.0.0.1 (a SAN of the fixture cert), not `localhost` — an
    // IPv6-first resolver would dial ::1 while the server listens on v4.
    const opts = buildRedisOpts(`rediss://127.0.0.1:${port}`, false);
    expect(opts).not.toBeNull();
    const socket = (opts as { socket: Record<string, unknown> }).socket;
    // reconnectStrategy: false so a failed handshake doesn't retry forever;
    // the fixture server is a bare TLS endpoint (no RESP), so connect() never
    // reaches 'ready' — the assertion is the server-side handshake event.
    const client = createClient({ ...opts, socket: { ...socket, reconnectStrategy: false } } as Parameters<typeof createClient>[0]);
    client.on('error', () => {
      /* handshake/protocol errors surface here; the test asserts via secureSeen */
    });
    const connecting = client.connect().catch(() => {});
    try {
      await secureSeen;
    } finally {
      // The assertion under test (a real TLS handshake happened) is already
      // proven by `secureSeen` above — everything below is best-effort
      // teardown, not part of what's being tested. That distinction matters
      // because @redis/client 1.6.1 has an internal race here: once the
      // client's own handshake completes it fires 'connect' and starts
      // awaiting its post-handshake RESP initiator (HELLO/AUTH/etc), which
      // this bare TLS fixture — not a real Redis server — never answers.
      // Calling disconnect() while that initiator is still in flight races
      // node-redis's OWN error path for the very same socket: disconnect()
      // destroys the socket and clears its internal handle, and if the
      // initiator's rejection handler (which also tries to destroy + clear
      // that same handle on its own failure path) runs after, it throws
      // `Cannot read properties of undefined (reading 'destroy')` instead of
      // the connection error it meant to report (confirmed locally via
      // temporary instrumentation — this fires as a client 'error' event and
      // as the `connect()` promise's rejection reason). Depending on exact
      // timing this can also leave the teardown promises never settling.
      // Rather than chase the library's internal state machine, bound the
      // whole teardown so a hang here can NEVER consume Jest's global test
      // timeout — anything left over is a leaked handle Jest already
      // tolerates (force-exits the worker), not a test failure.
      const teardown = (async () => {
        await client.disconnect().catch(() => {});
        await connecting;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        teardown.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });
});
