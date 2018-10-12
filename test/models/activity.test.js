var chai = require('chai')

var expect = chai.expect

var sinon = require('sinon')

var sinonChai = require('sinon-chai')

var utils = require('../utils.js')
chai.use(sinonChai)

describe('Activity', function() {
  var Activity = utils.models.Activity
  var mongoose = utils.mongoose

  describe('.createByParameters', function() {
    context('correct parameters', function() {
      it('should create', function() {
        var userId = mongoose.Types.ObjectId()
        var targetId = mongoose.Types.ObjectId()

        var parameters = {
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
        var userId = mongoose.Types.ObjectId()
        var targetId = mongoose.Types.ObjectId()

        var parameters = {
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
})
