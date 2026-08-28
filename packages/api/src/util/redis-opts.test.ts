import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import Debug from 'debug';
import { createClient } from 'redis';
import { buildRedisOpts, duplicateWithErrorHandler, redisReconnectForever } from './redis-opts';

/**
 * The v4-compatible pins `buildRedisOpts` adds to every result (see its
 * docstring), factored out so each shape assertion below states only the
 * URL-derived fields it's actually testing.
 */
const v4Pins = { RESP: 2, commandOptions: { timeout: undefined } };
const v4Socket = (socket: Record<string, unknown>) => ({
  keepAlive: true,
  keepAliveInitialDelay: 5000,
  reconnectStrategy: redisReconnectForever,
  ...socket,
});

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
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6380, tls: true, requestCert: true, rejectUnauthorized: true }),
      database: 0,
    });
    expect(buildRedisOpts('rediss://localhost:6380', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6380, tls: true, requestCert: true, rejectUnauthorized: false }),
      database: 0,
    });
  });

  it('redis://user:pass@host forwards BOTH the ACL username and password (decoded), matching collab parseRedisUrlForIoredis', () => {
    // node-redis v4 AUTHs with the top-level `username` option (ACL). The
    // old implementation kept only the password, so an ACL URL had the api
    // client authenticating as the `default` user while collab's ioredis
    // parser (extension-redis.ts) passed both — same URL, divergent auth.
    expect(buildRedisOpts('redis://app%40svc:p%40ss@localhost:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
      username: 'app@svc',
      password: 'p@ss',
    });
  });

  it('redis://:pass@host (empty username) stays password-only; redis://user@host (no colon) is username-only', () => {
    expect(buildRedisOpts('redis://:secret@localhost:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
      password: 'secret',
    });
    expect(buildRedisOpts('redis://onlyuser@localhost:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
      username: 'onlyuser',
    });
  });

  it('decodes credentials exactly ONCE and keeps the user:pass boundary for encoded colons (legacy url.parse pre-decoded and broke both)', () => {
    // %2540 must decode to the literal '%40' (NOT '@' — that would be a
    // double decode), and an encoded ':' must stay inside the password.
    expect(buildRedisOpts('redis://acl:p%2540ss@localhost:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
      username: 'acl',
      password: 'p%40ss',
    });
    expect(buildRedisOpts('redis://acl:pa%3Ass@localhost:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
      username: 'acl',
      password: 'pa:ss',
    });
  });

  it('IPv6 literal hosts lose the WHATWG brackets (net/tls connect want the bare address)', () => {
    expect(buildRedisOpts('redis://[::1]:6379', false)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: '::1', port: 6379 }),
      database: 0,
    });
  });

  it('redis:// carries no tls key at all', () => {
    expect(buildRedisOpts('redis://localhost:6379', true)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
    });
  });

  it('a REDIS_URL database pathname (feature-redis-key-prefix §3) is parsed into the top-level `database` field', () => {
    expect(buildRedisOpts('redis://localhost:6379/0', true)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 0,
    });
    expect(buildRedisOpts('redis://localhost:6379/1', true)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'localhost', port: 6379 }),
      database: 1,
    });
    expect(buildRedisOpts('rediss://ACL-user:password@host/1', true)).toStrictEqual({
      ...v4Pins,
      socket: v4Socket({ host: 'host', port: 6379, tls: true, requestCert: true, rejectUnauthorized: true }),
      database: 1,
      username: 'ACL-user',
      password: 'password',
    });
  });

  it('pins v4-compatible defaults so the installed node-redis major cannot silently change connection behavior (AC-8/AC-9)', () => {
    const opts = buildRedisOpts('redis://localhost:6379', true) as {
      RESP: number;
      commandOptions: { timeout: unknown };
      socket: { keepAlive: boolean; keepAliveInitialDelay: number; reconnectStrategy: (retries: number) => number | Error };
    };
    expect(opts.RESP).toBe(2);
    expect(opts.commandOptions).toStrictEqual({ timeout: undefined });
    expect(opts.socket.keepAlive).toBe(true);
    expect(opts.socket.keepAliveInitialDelay).toBe(5000);
    // v4's actual default curve: linear, capped at 500ms, never an Error —
    // NOT v6's exponential+jittered (and abortable) default.
    expect(opts.socket.reconnectStrategy(0)).toBe(0);
    expect(opts.socket.reconnectStrategy(10)).toBe(500);
    expect(opts.socket.reconnectStrategy(1000)).toBe(500);
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

/**
 * feature-redis-subscriber-crash-fix — a duplicate pub/sub subscriber with
 * no `error` listener raises an unhandled EventEmitter `error` on a Redis
 * outage and crashes the whole api process (the 2026-07-27 almoha
 * production Redis 7→8 restart). `duplicateWithErrorHandler` is the single
 * helper that attaches one; `.eslintrc.js`'s `no-restricted-syntax` guard
 * (see `test/eslint-db-guard.test.ts`) makes it the only allowed call site
 * for `.duplicate()` outside this file, in production AND test code alike.
 */
describe('duplicateWithErrorHandler', () => {
  /**
   * Minimal fake matching `duplicateWithErrorHandler`'s (unexported, purely
   * structural) client requirement — `duplicate()` plus `on('error' | 'ready',
   * ...)` — that records every lifecycle call the helper must NOT make
   * (`connect`/`subscribe`/`unsubscribe`/`disconnect`) and every `on()`
   * registration, and exposes `emitError` / `emitReady` to drive the
   * listeners the helper attached — mirroring how node-redis itself would
   * invoke them. Deliberately does not `implements` the (unexported) helper
   * interface; TS structural typing is what lets this satisfy
   * `duplicateWithErrorHandler<T extends ...>` without importing it.
   */
  class RecordingRedisClient {
    duplicateCallCount = 0;
    connectCallCount = 0;
    subscribeCallCount = 0;
    unsubscribeCallCount = 0;
    disconnectCallCount = 0;
    readonly listenerRegistrations: Array<'error' | 'ready'> = [];
    private readonly errorListeners: Array<(err: Error) => void> = [];
    private readonly readyListeners: Array<() => void> = [];

    duplicate(): RecordingRedisClient {
      this.duplicateCallCount += 1;
      // A fresh instance — mirrors node-redis returning a distinct
      // duplicate connection, never the primary itself.
      return new RecordingRedisClient();
    }

    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'error' | 'ready', listener: ((err: Error) => void) | (() => void)): this {
      this.listenerRegistrations.push(event);
      if (event === 'error') {
        this.errorListeners.push(listener as (err: Error) => void);
      } else {
        this.readyListeners.push(listener as () => void);
      }
      return this;
    }

    async connect(): Promise<unknown> {
      this.connectCallCount += 1;
      return undefined;
    }

    async subscribe(): Promise<void> {
      this.subscribeCallCount += 1;
    }

    async unsubscribe(): Promise<void> {
      this.unsubscribeCallCount += 1;
    }

    async disconnect(): Promise<unknown> {
      this.disconnectCallCount += 1;
      return undefined;
    }

    emitError(message: string): void {
      for (const listener of this.errorListeners) listener(new Error(message));
    }

    emitReady(): void {
      for (const listener of this.readyListeners) listener();
    }
  }

  it('calls client.duplicate() exactly once with no option override, and returns that SAME duplicate instance', () => {
    const client = new RecordingRedisClient();
    const duplicateSpy = jest.spyOn(client, 'duplicate');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const returned = duplicateWithErrorHandler(client, 'test subscriber');

    expect(client.duplicateCallCount).toBe(1);
    expect(duplicateSpy).toHaveBeenCalledWith();
    expect(duplicateSpy).toHaveReturnedWith(returned);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('registers the error listener before the ready listener, on the duplicate, before connect() — and never calls connect/subscribe/unsubscribe/disconnect itself', () => {
    const client = new RecordingRedisClient();

    const duplicate = duplicateWithErrorHandler(client, 'test subscriber');

    expect(duplicate.listenerRegistrations).toEqual(['error', 'ready']);
    // The listeners are on the DUPLICATE, not the primary client.
    expect(client.listenerRegistrations).toEqual([]);
    // Lifecycle ownership stays entirely with the caller.
    expect(duplicate.connectCallCount).toBe(0);
    expect(duplicate.subscribeCallCount).toBe(0);
    expect(duplicate.unsubscribeCallCount).toBe(0);
    expect(duplicate.disconnectCallCount).toBe(0);
  });

  it('does not log anything on the initial connection ready (no prior error observed)', () => {
    const client = new RecordingRedisClient();
    const duplicate = duplicateWithErrorHandler(client, 'test subscriber');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    duplicate.emitReady();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('error→error→ready→error→ready: warns once per outage (2), demotes the retry error to debug (1), and logs recovery once per ready-after-outage (2)', () => {
    const client = new RecordingRedisClient();
    const duplicate = duplicateWithErrorHandler(client, 'test subscriber');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // `Debug()` instances resolve their `.enabled` state from a live getter
    // that re-checks `namespaces` on every access (debug/src/common.js), so
    // calling `enable()` here — AFTER `redis-opts.ts`'s own module-scoped
    // debug instance was already created at import time — still takes
    // effect for the calls this test triggers below. Restore whatever was
    // enabled before so this doesn't leak debug output into other files.
    const previousNamespaces = Debug.disable();
    Debug.enable(previousNamespaces ? `${previousNamespaces},crowi:util:redis-opts` : 'crowi:util:redis-opts');

    try {
      duplicate.emitError('connection reset 1');
      duplicate.emitError('connection reset 2');
      duplicate.emitReady();
      duplicate.emitError('connection reset 3');
      duplicate.emitReady();

      const warnMessages = warnSpy.mock.calls.map((args) => args.join(' '));
      const outageWarnings = warnMessages.filter((m) => m.includes('test subscriber') && m.includes('lost connection'));
      const recoveryWarnings = warnMessages.filter((m) => m.includes('test subscriber') && m.includes('recovered'));
      expect(outageWarnings).toHaveLength(2);
      expect(recoveryWarnings).toHaveLength(2);
      expect(warnMessages).toHaveLength(4);
      // The FIRST error of each outage carries the error message; the
      // retried (2nd) error of the SAME outage does not reach warn at all.
      expect(outageWarnings[0]).toContain('connection reset 1');
      expect(outageWarnings[1]).toContain('connection reset 3');

      // The retried error (connection reset 2) was demoted to `debug`
      // instead of a second warn — exactly one debug line for this namespace.
      const debugLines = stderrSpy.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('crowi:util:redis-opts'));
      expect(debugLines).toHaveLength(1);
      expect(debugLines[0]).toContain('connection reset 2');
    } finally {
      Debug.enable(previousNamespaces);
    }
  });

  it('a `ready` that follows an already-logged recovery (no new `error` in between) does not log a second recovery line', () => {
    // AC-2's "recovery log once per ready-after-outage" — this pins the
    // OTHER half of that "once": after `outageWarned` was already flipped
    // back to `false` by a recovery `ready`, a FURTHER `ready` with no
    // intervening `error` must stay silent, exactly like the very first,
    // pre-outage `ready` (covered by the test above). Without this, a
    // regression that logged recovery unconditionally on every `ready` —
    // instead of gating on `outageWarned` — would slip through the
    // error→error→ready→error→ready test above, since that test only
    // asserts the total recovery COUNT (2) matches the number of `ready`s
    // that follow an outage, not that a THIRD, outage-free `ready` stays
    // silent.
    const client = new RecordingRedisClient();
    const duplicate = duplicateWithErrorHandler(client, 'test subscriber');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    duplicate.emitError('connection reset');
    duplicate.emitReady();
    warnSpy.mockClear();

    duplicate.emitReady();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
