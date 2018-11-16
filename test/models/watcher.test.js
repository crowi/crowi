const chai = require('chai')
const expect = chai.expect
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
const utils = require('../utils.js')
chai.use(sinonChai)

describe('Watcher', function() {
  const Watcher = utils.models.Watcher
  const mongoose = utils.mongoose
  const ObjectId = mongoose.Types.ObjectId

  describe('.upsertWatcher', function() {
    context('valid parameters', function() {
      it('should create', async function() {
        const userId = ObjectId()
        const targetId = ObjectId()

        try {
          const watcher = await Watcher.upsertWatcher(userId, 'Page', targetId, Watcher.STATUS_WATCH)
          expect(watcher.user.toString()).to.be.equal(userId.toString())
          expect(watcher.targetModel).to.be.equal('Page')
          expect(watcher.target.toString()).to.be.equal(targetId.toString())
          expect(watcher.status).to.be.equal(Watcher.STATUS_WATCH)
        } catch (err) {
          throw new Error(err)
        }
      })
    })
  })
})
