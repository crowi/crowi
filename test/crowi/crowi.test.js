const path = require('path')
const utils = require('../utils.js')

describe('Test for Crowi application context', () => {
  const Crowi = require('../../lib/crowi')
  const mongoose = require('mongoose')
  const crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)

  beforeAll(async () => {
    crowi.models = utils.models
    // FIXME: This is a hack
    crowi.redisOpts = null
    await crowi.setupConfig()
    return crowi
  })

  describe('construction', () => {
    test('initialize crowi context', () => {
      expect(crowi).toBeInstanceOf(Crowi)
      expect(crowi.version).toBe(require('../../package.json').version)
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
      expect(mongoose.connection.readyState).toBe(1)
    })
  })
})
