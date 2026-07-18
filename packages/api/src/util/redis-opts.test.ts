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
    });
    expect(buildRedisOpts('rediss://localhost:6380', false)).toStrictEqual({
      socket: { host: 'localhost', port: 6380, tls: true, requestCert: true, rejectUnauthorized: false },
    });
  });

  it('redis:// carries no tls key at all', () => {
    expect(buildRedisOpts('redis://localhost:6379', true)).toStrictEqual({
      socket: { host: 'localhost', port: 6379 },
    });
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
      await client.disconnect().catch(() => {});
      await connecting;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
