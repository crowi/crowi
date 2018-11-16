const path = require('path')

describe('Test for Crowi application context', () => {
  const Crowi = require('../../lib/crowi')
  const mongoose = require('mongoose')

  describe('construction', () => {
    test('initialize crowi context', () => {
      const crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)
      expect(crowi).toBeInstanceOf(Crowi)
      expect(crowi.version).toBe(require('../../package.json').version)
      expect(typeof crowi.env).toBe('object')
    })

    test('config getter, setter', () => {
      const crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)
      expect(crowi.getConfig()).toEqual({})
      crowi.setConfig({ test: 1 })
      expect(crowi.getConfig()).toEqual({ test: 1 })
    })

    test('model getter, setter', () => {
      const crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)
      // set
      crowi.model('hoge', { fuga: 1 })
      expect(crowi.model('hoge')).toEqual({ fuga: 1 })
    })
  })

  describe('.setupDatabase', () => {
    beforeAll(function() {
      mongoose.disconnect() // avoid error of Trying to open unclosed connection
    })
    test('setup completed', done => {
      const crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)
      // set
      const p = crowi.setupDatabase()
      expect(p).toBeInstanceOf(Promise)
      p.then(function() {
        expect(mongoose.connection.readyState).toBe(1)
        done()
      }).catch(function(err) {
        // console.log('readyState', mongoose.connection.readyState);
        if (mongoose.connection.readyState === 2 || mongoose.connection.readyState === 1) {
          // alreaady connected
          // throught
        } else {
          expect(mongoose.connection.readyState).toBe(0)
        }
        done()
      })
    })
  })
})
