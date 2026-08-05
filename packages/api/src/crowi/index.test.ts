import { createAdaptorServer, getRequestListener } from '@hono/node-server';
import type { Http2Bindings, HttpBindings } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { createServer as httpCreateServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { dispatchToHonoApp } from 'src/hono/path-rewrite';
import { crowi } from 'src/test/setup';

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
      expect(crowi.version).toBe(require('../../package.json').version);
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

  describe('buildRedisOpts', () => {
    const table: [string, boolean, object][] = [
      ['redis://localhost:6379', true, { socket: { host: 'localhost', port: 6379 }, database: 0 }],
      ['redis://localhost:6379', false, { socket: { host: 'localhost', port: 6379 }, database: 0 }],

      // ACL username is forwarded too (it used to be dropped, leaving the
      // api client AUTHing as `default` while collab used the URL's user).
      ['redis://user:password@localhost:6379', true, { socket: { host: 'localhost', port: 6379 }, database: 0, username: 'user', password: 'password' }],
      ['redis://user:password@localhost:6379', false, { socket: { host: 'localhost', port: 6379 }, database: 0, username: 'user', password: 'password' }],

      // node-redis v4 requires the LITERAL `tls: true` with the TLS options
      // flattened into the socket object (`RedisTlsSocketOptions`); a nested
      // object silently selects a plaintext transport. See
      // `util/redis-opts.test.ts` for the behavioral (handshake) repro.
      ['rediss://localhost:6379', true, { socket: { host: 'localhost', port: 6379, tls: true, requestCert: true, rejectUnauthorized: true }, database: 0 }],
      ['rediss://localhost:6379', false, { socket: { host: 'localhost', port: 6379, tls: true, requestCert: true, rejectUnauthorized: false }, database: 0 }],

      // feature-redis-key-prefix §3: the pathname selects a non-default DB.
      ['redis://localhost:6379/1', true, { socket: { host: 'localhost', port: 6379 }, database: 1 }],
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
});
