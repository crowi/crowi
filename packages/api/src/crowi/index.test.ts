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
      ['redis://localhost:6379', true, { socket: { host: 'localhost', port: 6379 } }],
      ['redis://localhost:6379', false, { socket: { host: 'localhost', port: 6379 } }],

      ['redis://user:password@localhost:6379', true, { socket: { host: 'localhost', port: 6379 }, password: 'password' }],
      ['redis://user:password@localhost:6379', false, { socket: { host: 'localhost', port: 6379 }, password: 'password' }],

      ['rediss://localhost:6379', true, { socket: { host: 'localhost', port: 6379, tls: { requestCert: true, rejectUnauthorized: true } } }],
      ['rediss://localhost:6379', false, { socket: { host: 'localhost', port: 6379, tls: { requestCert: true, rejectUnauthorized: false } } }],
    ];

    test.each(table)('parse %s', (url, redisRejectUnauthorized, expected) => {
      expect(crowi.buildRedisOpts(url, redisRejectUnauthorized)).toStrictEqual(expected);
    });
  });
});
