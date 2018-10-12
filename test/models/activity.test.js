const chai = require('chai')

const expect = chai.expect

const sinon = require('sinon')

const sinonChai = require('sinon-chai')

const utils = require('../utils.js')
chai.use(sinonChai)

describe('Activity', function() {
  const Activity = utils.models.Activity
  const mongoose = utils.mongoose
  const ObjectId = mongoose.Types.ObjectId

  describe('.createByParameters', function() {
    context('correct parameters', function() {
      it('should create', function() {
        const userId = ObjectId()
        const targetId = ObjectId()

        const parameters = {
          user: userId,
          targetModel: 'Page',
          target: targetId,
          action: 'COMMENT',
        }

        return Activity.createByParameters(parameters).then(
          function(activity) {
            expect(activity.user).to.be.equal(userId)
            expect(activity.target).to.be.equal(targetId)
            expect(activity.targetModel).to.be.equal('Page')
            expect(activity.action).to.be.equal('COMMENT')
          },
          function(err) {
            throw new Error(err)
          },
        )
      })
    })

    context('invalid parameters', function() {
      it('should not create', function() {
        const userId = ObjectId()
        const targetId = ObjectId()

        const parameters = {
          user: userId,
          targetModel: 'Page2', // validation error
          target: targetId,
          action: 'COMMENT',
        }

        return Activity.createByParameters(parameters).then(
          function(activity) {
            throw new Error('not fulfilled')
          },
          function(err) {
            expect(err.message).to.be.equal('Activity validation failed')
          },
        )
      })
    })
  })

  describe('.removeByParameters', () => {
    context('correct parameters', () => {
      const user = ObjectId()
      const target = ObjectId()
      const parameters = { user, targetModel: 'Page', target, action: 'COMMENT' }

      before(async () => {
        await Activity.createByParameters(parameters)
      })

      it('should remove', async () => {
        const { result } = await Activity.removeByParameters(parameters)
        expect(result).to.deep.equal({ n: 1, ok: 1 })
      })
    })
  })
})
