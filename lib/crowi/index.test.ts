import { crowi } from 'server/test/setup'

describe('Test for Crowi application context', () => {
  // test crowi object by environment

  describe('construction', () => {
    test('initialize crowi context', () => {
      expect(crowi.version).toBe(require('../../package.json').version)
      expect(crowi.isInitialized()).toBe(true)
      expect(typeof crowi.env).toBe('object')
    })

    test('config getter, setter', () => {
      expect(crowi.getConfig()).toEqual({ crowi: {} })
      crowi.setConfig({})
      expect(crowi.getConfig()).toEqual({})
      crowi.setConfig({ test: 1 })
      expect(crowi.getConfig()).toEqual({ test: 1 })
    })

    test('model getter, setter', () => {
      // set
      crowi.model('hoge' as any, { fuga: 1 })
      expect(crowi.model('hoge' as any)).toEqual({ fuga: 1 })
    })
  })

  describe('.setupDatabase', () => {
    test('setup completed', () => {
      expect(crowi.getMongo().connection.readyState).toBe(1)
    })
  })

  describe('buildRedisOpts', () => {
    const table: [string, boolean, object][] = [
      ['redis://localhost:6379', true,  {host: 'localhost', port: '6379'}],
      ['redis://localhost:6379', false, {host: 'localhost', port: '6379'}],

      ['redis://user:password@localhost:6379', true,  {host: 'localhost', port: '6379', password: 'password'}],
      ['redis://user:password@localhost:6379', false, {host: 'localhost', port: '6379', password: 'password'}],

      ['rediss://localhost:6379', true,  {host: 'localhost', port: '6379', tls: {requestCert: true, rejectUnauthorized: true}}],
      ['rediss://localhost:6379', false, {host: 'localhost', port: '6379', tls: {requestCert: true, rejectUnauthorized: false}}],
    ]

    test.each(table)('parse %s', (url, redisRejectUnauthorized, expected) => {
      expect(crowi.buildRedisOpts(url, redisRejectUnauthorized)).toStrictEqual(expected);
    })
  })
})
