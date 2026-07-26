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
});
