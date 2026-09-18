import { type Server as HttpServer, createServer as httpCreateServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Http2Bindings, HttpBindings } from '@hono/node-server';
import { createAdaptorServer, getRequestListener } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import Debug from 'debug';
import { Hono } from 'hono';
import { dispatchToHonoApp } from 'src/hono/path-rewrite';
import {
  createFailureReasonFault,
  type FailureReasonFaultMode,
  FatalWriteSentinel,
  installOneShotTimestampFaultSpy,
} from 'src/test/process-fatal-test-doubles';
import { crowi } from 'src/test/setup';
import type { LogRecord } from 'src/util/logger';
import * as loggerSinkModule from 'src/util/logger-sink';
import { redisReconnectForever } from 'src/util/redis-opts';
import { runWithRequestScope } from 'src/util/request-scope';
import { version as pkgVersion } from '../../package.json';

/**
 * The v4-compatible pins `buildRedisOpts` adds to every result (see
 * `util/redis-opts.ts`'s docstring) — factored out so the table below states
 * only the URL-derived fields it's actually testing.
 */
const v4Pins = { RESP: 2, commandOptions: { timeout: undefined } };
const v4Socket = (socket: Record<string, unknown>) => ({
  keepAlive: true,
  keepAliveInitialDelay: 5000,
  reconnectStrategy: redisReconnectForever,
  ...socket,
});

describe('Test for Crowi application context', () => {
  // test crowi object by environment

  describe('construction', () => {
    // The `crowi` singleton is shared across every test file in this worker.
    // The getter/setter tests below mutate its config + model registry, so
    // snapshot the touched state and restore it afterwards — otherwise the
    // wiped config / leftover fake `hoge` model leaks into whatever file this
    // worker runs next (order-fragile cross-file flake).
    let configSnapshot: Record<string, unknown>;

    beforeAll(() => {
      // getConfig() returns the live mutable object; deep-clone for the snapshot.
      configSnapshot = JSON.parse(JSON.stringify(crowi.getConfig()));
    });

    afterAll(() => {
      crowi.setConfig(configSnapshot);
      // Drop the fake model registered by the model getter/setter test so it
      // does not shadow a real model in a later file.
      delete (crowi.models as Record<string, unknown>).hoge;
    });

    test('initialize crowi context', () => {
      expect(crowi.version).toBe(pkgVersion);
      expect(crowi.isInitialized()).toBe(true);
      expect(typeof crowi.env).toBe('object');
    });

    test('config getter, setter', () => {
      expect(crowi.getConfig()).toEqual({ crowi: {} });
      crowi.setConfig({});
      expect(crowi.getConfig()).toEqual({});
      crowi.setConfig({ test: 1 });
      expect(crowi.getConfig()).toEqual({ test: 1 });
    });

    test('model getter, setter', () => {
      // set
      crowi.model('hoge' as any, { fuga: 1 });
      expect(crowi.model('hoge' as any)).toEqual({ fuga: 1 });
    });
  });

  describe('.setupDatabase', () => {
    test('setup completed', () => {
      expect(crowi.getMongo().connection.readyState).toBe(1);
    });
  });

  describe('AC-10: .ensureRelationUniqueIndexes', () => {
    // Swap in fake `Like` / `Seen` model registrations for the duration of
    // each test and restore the real ones afterward — other tests in this
    // (per-file) `crowi` singleton rely on the real models being registered.
    // `crowi` itself is only populated once `setup.ts`'s `beforeAll` runs,
    // so these must be captured lazily (not at `describe`-body eval time).
    let realLike: ReturnType<typeof crowi.model<'Like'>>;
    let realSeen: ReturnType<typeof crowi.model<'Seen'>>;

    beforeAll(() => {
      realLike = crowi.model('Like');
      realSeen = crowi.model('Seen');
    });

    afterEach(() => {
      crowi.model('Like', realLike);
      crowi.model('Seen', realSeen);
    });

    test('propagates a Seen rejection unchanged', async () => {
      const seenError = new Error('seen index build failed');
      crowi.model('Like', { ensureUniqueIndex: async () => undefined } as unknown as typeof realLike);
      crowi.model('Seen', {
        ensureUniqueIndex: async () => {
          throw seenError;
        },
      } as unknown as typeof realSeen);

      await expect(crowi.ensureRelationUniqueIndexes()).rejects.toBe(seenError);
    });

    test('awaits Like before resolving — a Like-then-Seen implementation without awaiting Like would pass this incorrectly', async () => {
      let resolveLike: (() => void) | undefined;
      const likeDeferred = new Promise<void>((resolve) => {
        resolveLike = resolve;
      });
      let seenCalled = false;
      crowi.model('Like', { ensureUniqueIndex: () => likeDeferred } as unknown as typeof realLike);
      crowi.model('Seen', {
        ensureUniqueIndex: async () => {
          seenCalled = true;
        },
      } as unknown as typeof realSeen);

      let settled = false;
      const promise = crowi.ensureRelationUniqueIndexes().then(() => {
        settled = true;
      });

      // Before Like resolves, Seen must not have been reached and the
      // overall method promise must still be pending (await-leak detector).
      await Promise.resolve();
      await Promise.resolve();
      expect(seenCalled).toBe(false);
      expect(settled).toBe(false);

      resolveLike?.();
      await promise;
      expect(seenCalled).toBe(true);
      expect(settled).toBe(true);
    });
  });

  describe('buildRedisOpts', () => {
    const table: [string, boolean, object][] = [
      ['redis://localhost:6379', true, { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379 }), database: 0 }],
      ['redis://localhost:6379', false, { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379 }), database: 0 }],

      // ACL username is forwarded too (it used to be dropped, leaving the
      // api client AUTHing as `default` while collab used the URL's user).
      [
        'redis://user:password@localhost:6379',
        true,
        { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379 }), database: 0, username: 'user', password: 'password' },
      ],
      [
        'redis://user:password@localhost:6379',
        false,
        { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379 }), database: 0, username: 'user', password: 'password' },
      ],

      // node-redis v4 requires the LITERAL `tls: true` with the TLS options
      // flattened into the socket object (`RedisTlsSocketOptions`); a nested
      // object silently selects a plaintext transport. See
      // `util/redis-opts.test.ts` for the behavioral (handshake) repro.
      [
        'rediss://localhost:6379',
        true,
        { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379, tls: true, requestCert: true, rejectUnauthorized: true }), database: 0 },
      ],
      [
        'rediss://localhost:6379',
        false,
        { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379, tls: true, requestCert: true, rejectUnauthorized: false }), database: 0 },
      ],

      // feature-redis-key-prefix §3: the pathname selects a non-default DB.
      ['redis://localhost:6379/1', true, { ...v4Pins, socket: v4Socket({ host: 'localhost', port: 6379 }), database: 1 }],
    ];

    test.each(table)('parse %s', (url, redisRejectUnauthorized, expected) => {
      expect(crowi.buildRedisOpts(url, redisRejectUnauthorized)).toStrictEqual(expected);
    });
  });

  describe('boot degrade when Redis is configured but unreachable', () => {
    // Reserve a port nothing listens on: bind an ephemeral port, then close.
    const reserveDeadPort = async (): Promise<number> => {
      const net = await import('node:net');
      const srv = net.createServer();
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const port = (srv.address() as import('node:net').AddressInfo).port;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      return port;
    };

    test('.setupRedisClient resolves with redis=null instead of hanging (repro: default reconnectStrategy retries forever, the degrade catch was unreachable)', async () => {
      const savedOpts = crowi.redisOpts;
      const savedRedis = crowi.redis;
      try {
        crowi.redisOpts = crowi.buildRedisOpts(`redis://127.0.0.1:${await reserveDeadPort()}`, false);
        await crowi.setupRedisClient();
        expect(crowi.redis).toBeNull();
      } finally {
        crowi.redisOpts = savedOpts;
        crowi.redis = savedRedis;
      }
    }, 60_000);

    test('.setupPubSub is a no-op when the boot Redis connection degraded (repro: it gated on redisOpts and hung on the same dead server)', async () => {
      const ConfigService = (await import('src/service/config')).default;
      const deadOpts = crowi.buildRedisOpts(`redis://127.0.0.1:${await reserveDeadPort()}`, false);
      const svc = new ConfigService({ redisOpts: deadOpts, redis: null, model: () => ({}) } as never);
      await svc.setupPubSub();
      expect(svc.pubSub.publisher).toBeNull();
    }, 15_000);
  });

  describe('node-server fetchFn (request, env) wiring (RFC-0014 phase 1 AC-8)', () => {
    // `dispatchToHonoApp` (`src/hono/path-rewrite.ts`) is the ONE shared
    // implementation BOTH `start()`'s production fetchFn (`crowi/index.ts`)
    // and `src/test/setup.ts`'s supertest listener call.
    //
    // A test that only calls `dispatchToHonoApp` directly with a hand-rolled
    // fake `env` object (as an earlier revision of this suite did) cannot
    // catch a regression at either CALL SITE — e.g. `crowi/index.ts:start()`
    // silently reverting to a 1-arg `(request) => dispatchToHonoApp(honoApp,
    // request, undefined)` that drops `env` before it ever reaches this
    // function. Both call sites build their `fetchFn` closure as `(request,
    // env) => dispatchToHonoApp(honoApp, request, env)` and hand it to a
    // REAL `@hono/node-server` entry point — `createAdaptorServer` in
    // `start()`, `getRequestListener` in `src/test/setup.ts` (verified:
    // `createAdaptorServer` itself calls `getRequestListener` internally,
    // see `@hono/node-server`'s `dist/index.mjs`) — which is what supplies
    // the REAL `env` (`{ incoming, outgoing }`, Node's actual
    // `IncomingMessage`/`ServerResponse` pair) over an actual TCP
    // connection. The two cases below reproduce that exact wiring against
    // each entry point and drive it with a genuine HTTP request instead of
    // an object literal shaped like `env` — closing the gap a fake `env`
    // could not: a call-site regression that drops the `env` PARAMETER
    // itself (not just something inside `dispatchToHonoApp`) now fails
    // here too, because these tests build the identical one-line closure
    // BOTH real call sites use and can only pass if that closure keeps
    // forwarding `env`.
    const buildConnInfoApp = (): Hono => {
      const app = new Hono();
      app.get('/conn', (c) => {
        const info = getConnInfo(c);
        return c.json({ hasAddress: typeof info.remote.address === 'string', hasPort: typeof info.remote.port === 'number' });
      });
      return app;
    };

    /** Listens on an ephemeral port, GETs `/api/conn` for real, then closes — bounded so a hung listener cannot stall the suite. */
    const requestConnInfoOver = async (server: HttpServer): Promise<{ hasAddress: boolean; hasPort: boolean }> => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/api/conn`);
        return (await res.json()) as { hasAddress: boolean; hasPort: boolean };
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };

    it('reaches c.env.incoming via createAdaptorServer — the exact @hono/node-server function start() calls to build the production listener', async () => {
      const honoApp = buildConnInfoApp();
      const fetchFn = (request: Request, env: HttpBindings | Http2Bindings): Response | Promise<Response> => dispatchToHonoApp(honoApp, request, env);
      const server = createAdaptorServer({ fetch: fetchFn, createServer: httpCreateServer, port: 0 }) as HttpServer;
      await expect(requestConnInfoOver(server)).resolves.toEqual({ hasAddress: true, hasPort: true });
    });

    it("reaches c.env.incoming via getRequestListener — the exact @hono/node-server function src/test/setup.ts's shared listener calls", async () => {
      const honoApp = buildConnInfoApp();
      const fetchFn = (request: Request, env: HttpBindings | Http2Bindings): Response | Promise<Response> => dispatchToHonoApp(honoApp, request, env);
      const server = httpCreateServer(getRequestListener(fetchFn));
      await expect(requestConnInfoOver(server)).resolves.toEqual({ hasAddress: true, hasPort: true });
    });

    it('still strips the /api prefix through dispatchToHonoApp directly (unit-level, complements the two end-to-end cases above)', async () => {
      const app = buildConnInfoApp();
      const fakeEnv = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 54321, remoteFamily: 'IPv4' } }, outgoing: {} };
      const res = await dispatchToHonoApp(app, new Request('http://localhost/api/conn'), fakeEnv);
      expect(await res.json()).toEqual({ hasAddress: true, hasPort: true });
    });
  });

  describe('exitOnError (RFC-0025 process-boundary D-P4)', () => {
    // `crowi` is the shared, already-booted singleton (`src/test/setup.ts`)
    // — every case here spies the ALREADY-LOADED `src/util/logger-sink`
    // module export (ts-jest compiles `writeFatal(record)` call sites to a
    // property read at call time, so the spy intercepts it) rather than
    // isolating a fresh module registry: isolating would either let a real
    // fatal write terminate this Jest worker, or make the spy see zero
    // calls and pass vacuously.
    //
    // `FatalWriteSentinel`, `createFailureReasonFault` and
    // `installOneShotTimestampFaultSpy` are shared with
    // `util/process-boundary.unit.test.ts`'s in-process cases — see
    // `src/test/process-fatal-test-doubles.ts`.

    let stdoutWriteSpy: jest.SpiedFunction<typeof process.stdout.write>;
    let writeFatalSpy: jest.SpiedFunction<typeof loggerSinkModule.writeFatal>;

    beforeEach(() => {
      stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      writeFatalSpy = jest.spyOn(loggerSinkModule, 'writeFatal').mockImplementation((record: unknown) => {
        throw new FatalWriteSentinel(record);
      });
      // `restoreMocks: true` (jest.config.js, `server` project) restores
      // both spies after every test — no explicit `afterEach` needed.
    });

    describe('AC-P01: ordinary-path order for a standard Error', () => {
      test('after successful reporter disposal, writes the unchanged marker, then hands one exact full E-P1 to the fatal write', () => {
        const err = new Error('boot failed');
        expect(() => crowi.exitOnError(err)).toThrow(FatalWriteSentinel);

        expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
        expect(stdoutWriteSpy.mock.calls[0][0]).toBe(`@@crowi:fail api ${err.message}\n`);

        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect(record.level).toBe('error');
        expect(record.namespace).toBe('crowi:process');
        expect(record.message).toBe('fatal API startup error');
        expect(record.data).toEqual({ error: err });
      });
    });

    describe('AC-P02: accepted shapes, R-R1–R-R8 rejected shapes, and the bounded-work large-string row', () => {
      const acceptedTable: { label: string; value: unknown; expectedReason: string }[] = [
        { label: 'Error with an own string message', value: new Error('boom'), expectedReason: 'boom' },
        { label: 'Error with an own multi-line message (first line only)', value: new Error('line one\nline two'), expectedReason: 'line one' },
        { label: 'primitive string', value: 'plain string reason', expectedReason: 'plain string reason' },
        { label: 'primitive number', value: 42, expectedReason: '42' },
        { label: 'primitive boolean', value: true, expectedReason: 'true' },
      ];

      it.each(acceptedTable)('$label: marker/handoff/exit with reason "$expectedReason"', ({ value, expectedReason }) => {
        expect(() => crowi.exitOnError(value)).toThrow(FatalWriteSentinel);
        expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
        expect(stdoutWriteSpy.mock.calls[0][0]).toBe(`@@crowi:fail api ${expectedReason}\n`);
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
      });

      function buildInheritedAccessorNativeError(): Error {
        const err = new Error();
        const accessorProto = Object.create(Error.prototype, {
          message: {
            configurable: true,
            get() {
              throw new Error('crowi/index.test.ts: R-R8 inherited accessor must never be invoked');
            },
          },
        });
        Object.setPrototypeOf(err, accessorProto);
        return err;
      }

      const rejectedTable: { label: string; value: unknown }[] = [
        { label: 'R-R1: null', value: null },
        { label: 'R-R2: undefined', value: undefined },
        { label: 'R-R3: symbol primitive', value: Symbol('reason') },
        { label: 'R-R4: bigint primitive', value: 10n },
        { label: 'R-R5: ordinary object', value: { some: 'thing' } },
        { label: 'R-R6: Proxy', value: new Proxy({}, {}) },
        { label: 'R-R7: native Error with no own message descriptor', value: new Error() },
        { label: 'R-R8: native Error with no own message descriptor that inherits an accessor', value: buildInheritedAccessorNativeError() },
      ];

      it.each(rejectedTable)('$label: falls back to the fixed literal', ({ value }) => {
        expect(() => crowi.exitOnError(value)).toThrow(FatalWriteSentinel);
        expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
        expect(stdoutWriteSpy.mock.calls[0][0]).toBe('@@crowi:fail api unknown process failure\n');
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
      });

      test('after successful reporter disposal, covers every accepted and R-R1 through R-R8 rejected shape, proves the whole large reason is never split, and reaches marker one E-P1 handoff and exit 1 in every row (very large newline-dense primitive string row)', () => {
        const splitSpy = jest.spyOn(String.prototype, 'split');
        const huge = `${'x'.repeat(500)}\n`.repeat(5000);

        expect(() => crowi.exitOnError(huge)).toThrow(FatalWriteSentinel);

        expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
        expect(stdoutWriteSpy.mock.calls[0][0]).toBe(`@@crowi:fail api ${'x'.repeat(200)}\n`);
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        // The whole huge string is never the receiver of a `.split()` call
        // — only a bounded 200-code-unit slice is ever searched for `\n`.
        expect(splitSpy.mock.contexts).not.toContain(huge);
      });
    });

    describe('AC-P03: F-R1/F-R2/F-R3 — zero hook executions, fixed marker fallback, one handoff, exit reached', () => {
      const FAULT_ROWS: { label: string; mode: FailureReasonFaultMode }[] = [
        { label: 'F-R1: a Proxy whose getPrototypeOf would throw', mode: 'proxy-get-prototype-of' },
        { label: 'F-R2: an Error whose message is an accessor', mode: 'error-message-accessor' },
        { label: 'F-R3: a value whose Symbol.toPrimitive would never return', mode: 'symbol-to-primitive' },
      ];

      it.each(
        FAULT_ROWS,
      )('without in-process timers, uses a record-then-sentinel-throw F-R3 double, rejects every F-R row with zero hook executions, and reaches fixed marker one E-P1 handoff and exit 1 on each normal row path ($label)', ({
        mode,
      }) => {
        const fault = createFailureReasonFault(mode);
        expect(() => crowi.exitOnError(fault.value)).toThrow(FatalWriteSentinel);
        expect(fault.hookCalls()).toBe(0);
        expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
        expect(stdoutWriteSpy.mock.calls[0][0]).toBe('@@crowi:fail api unknown process failure\n');
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        // No timestamp fault in this row: the full record construction
        // SUCCEEDS and carries the hostile value unchanged — never put it
        // inside `toEqual`/`toMatchObject` (jest's deep-equality would
        // itself trip the hook), compare by reference instead.
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect((record.data as { error?: unknown } | undefined)?.error).toBe(fault.value);
      });
    });

    describe('AC-P15: legacy debug/plain-stack absence, proven with a runtime-enabled positive control', () => {
      test('runtime-enables crowi:crowi, proves the stderr spy with a same-namespace positive control, then uses stderr and console.error spies to reject every legacy fatal write', () => {
        const stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        // See `hono/handlers/oauth.test.ts`'s identical pattern: `Debug()`
        // instances resolve `.enabled` from a live getter re-checked on
        // every access, so enabling here (after `crowi/index.ts`'s
        // module-scoped `debug` instance was already created at import
        // time) still takes effect.
        const previousNamespaces = Debug.disable();
        Debug.enable(previousNamespaces ? `${previousNamespaces},crowi:crowi` : 'crowi:crowi');
        try {
          // Positive control FIRST: proves the spy actually observes a
          // `crowi:crowi`-namespaced `process.stderr.write` call before
          // relying on its absence to mean anything (a non-verbose Jest's
          // buffering global console would otherwise let a vacuous pass
          // through undetected).
          Debug('crowi:crowi')('positive control line');
          expect(stderrWriteSpy).toHaveBeenCalled();

          const stderrBaseline = stderrWriteSpy.mock.calls.length;
          const consoleErrorBaseline = consoleErrorSpy.mock.calls.length;

          expect(() => crowi.exitOnError(new Error('boot failed'))).toThrow(FatalWriteSentinel);

          expect(stderrWriteSpy.mock.calls.length).toBe(stderrBaseline);
          expect(consoleErrorSpy.mock.calls.length).toBe(consoleErrorBaseline);
        } finally {
          Debug.enable(previousNamespaces);
        }
      });
    });

    describe('AC-P18: live request scope — F-R1/F-R2/F-R3 combined with a timestamp fault reduce the record', () => {
      const FAULT_ROWS: { label: string; mode: FailureReasonFaultMode }[] = [
        { label: 'F-R1: a Proxy whose getPrototypeOf would throw', mode: 'proxy-get-prototype-of' },
        { label: 'F-R2: an Error whose message is an accessor', mode: 'error-message-accessor' },
        { label: 'F-R3: a value whose Symbol.toPrimitive would never return', mode: 'symbol-to-primitive' },
      ];

      it.each(
        FAULT_ROWS,
      )('inside live scope combines each F-R row with per-record timestamp failure and receives a fixed-epoch reduced E-P1 without requestId or hook execution; in-process F-R3 records entry then throws its sentinel ($label)', ({
        mode,
      }) => {
        const fault = createFailureReasonFault(mode);
        installOneShotTimestampFaultSpy();
        expect(() =>
          runWithRequestScope({ requestId: 'req-index-p18' }, () => {
            crowi.exitOnError(fault.value);
          }),
        ).toThrow(FatalWriteSentinel);
        expect(fault.hookCalls()).toBe(0);
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect(record.timestamp).toBe('1970-01-01T00:00:00.000Z');
        expect(record.level).toBe('error');
        expect(record.namespace).toBe('crowi:process');
        expect(record.message).toBe('fatal API startup error');
        expect(record.data).toEqual({ reduced: true, reason: 'unknown process failure' });
        expect('requestId' in record).toBe(false);
      });

      test('an ordinary own-string-descriptor Error row: same fixed timestamp, reason is the first-line/200-char result', () => {
        const err = new Error('multi\nline message');
        installOneShotTimestampFaultSpy();
        expect(() =>
          runWithRequestScope({ requestId: 'req-index-p18-ordinary' }, () => {
            crowi.exitOnError(err);
          }),
        ).toThrow(FatalWriteSentinel);
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect(record.timestamp).toBe('1970-01-01T00:00:00.000Z');
        expect(record.data).toEqual({ reduced: true, reason: 'multi' });
        expect('requestId' in record).toBe(false);
      });
    });

    describe('AC-P19: live request scope keeps requestId and exact error data on the full startup fatal record', () => {
      test('inside live scope keeps requestId and exact error data on full startup fatal record', () => {
        const err = new Error('boot failed with scope');
        expect(() =>
          runWithRequestScope({ requestId: 'req-index-p19' }, () => {
            crowi.exitOnError(err);
          }),
        ).toThrow(FatalWriteSentinel);
        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect(record.requestId).toBe('req-index-p19');
        expect(record.data).toEqual({ error: err });
      });
    });

    describe('AC-P25: marker-write throw and false-return rows still hand off the original E-P1 once', () => {
      test('contains marker write throw and false-return rows without listeners or waiting and still reaches one original E-P1 handoff and exit 1 (synchronous throw row)', () => {
        stdoutWriteSpy.mockRestore();
        stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {
          throw new Error('EPIPE-ish synchronous throw');
        });
        const drainListenersBefore = process.stdout.listenerCount('drain');
        const errorListenersBefore = process.stdout.listenerCount('error');

        const err = new Error('boot failed');
        expect(() => crowi.exitOnError(err)).toThrow(FatalWriteSentinel);

        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect((record.data as { error?: unknown } | undefined)?.error).toBe(err);
        expect(process.stdout.listenerCount('drain')).toBe(drainListenersBefore);
        expect(process.stdout.listenerCount('error')).toBe(errorListenersBefore);
      });

      test('contains marker write throw and false-return rows without listeners or waiting and still reaches one original E-P1 handoff and exit 1 (false-return row)', () => {
        stdoutWriteSpy.mockRestore();
        stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => false);
        const drainListenersBefore = process.stdout.listenerCount('drain');
        const errorListenersBefore = process.stdout.listenerCount('error');

        const err = new Error('boot failed again');
        expect(() => crowi.exitOnError(err)).toThrow(FatalWriteSentinel);

        expect(writeFatalSpy).toHaveBeenCalledTimes(1);
        const record = writeFatalSpy.mock.calls[0][0] as LogRecord;
        expect((record.data as { error?: unknown } | undefined)?.error).toBe(err);
        expect(process.stdout.listenerCount('drain')).toBe(drainListenersBefore);
        expect(process.stdout.listenerCount('error')).toBe(errorListenersBefore);
      });
    });
  });
});
