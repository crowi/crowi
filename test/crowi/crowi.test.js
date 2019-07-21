const path = require('path')
const Crowi = require(path.join(ROOT_DIR, '/lib/crowi'))

describe('Test for Crowi application context', () => {
  // test crowi object by environment
  const crowi = global.crowi

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
      crowi.model('hoge', { fuga: 1 })
      expect(crowi.model('hoge')).toEqual({ fuga: 1 })
    })
  })

  describe('.setupDatabase', () => {
    test('setup completed', () => {
      expect(crowi.getMongo().connection.readyState).toBe(1)
    })
  })
})
