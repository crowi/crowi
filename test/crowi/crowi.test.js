var chai = require('chai')
var expect = chai.expect
var sinon = require('sinon')
var sinonChai = require('sinon-chai')
var proxyquire = require('proxyquire')
var path = require('path')
var utils = require('../utils.js')
chai.use(sinonChai)

describe('Test for Crowi application context', function() {
  var Crowi = require('../../lib/crowi')
  var mongoose = utils.mongoose
  var crowi = new Crowi(path.normalize(path.join(__dirname, './../../')), process.env)

  before(async () => {
    crowi.models = utils.models
    // FIXME: This is a hack
    crowi.redisOpts = null
    await crowi.setupConfig()
    return crowi
  })

  describe('construction', function() {
    it('initialize crowi context', async function() {
      expect(crowi).to.be.instanceof(Crowi)
      expect(crowi.version).to.equal(require('../../package.json').version)
      expect(crowi.env).to.be.an('Object')
    })

    it('config getter, setter', async function() {
      expect(crowi.getConfig()).to.deep.equals({ crowi: {} })
      crowi.setConfig({})
      expect(crowi.getConfig()).to.deep.equals({})
      crowi.setConfig({ test: 1 })
      expect(crowi.getConfig()).to.deep.equals({ test: 1 })
    })

    it('model getter, setter', async function() {
      // set
      crowi.model('hoge', { fuga: 1 })
      expect(crowi.model('hoge')).to.deep.equals({ fuga: 1 })
    })
  })

  describe('.setupDatabase', function() {
    it('setup completed', async function() {
      expect(mongoose.connection.readyState).to.equals(1)
    })
  })
})
