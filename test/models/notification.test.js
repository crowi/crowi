var chai = require('chai')

var expect = chai.expect

var sinon = require('sinon')

var sinonChai = require('sinon-chai')

var utils = require('../utils.js')
chai.use(sinonChai)

describe('Notification', function() {
  var Comment = utils.models.Comment
  var Notification = utils.models.Notification
  var Page = utils.models.Page
  var User = utils.models.User
  var Activity = utils.models.Activity
  var mongoose = utils.mongoose
  var conn = utils.mongoose.connection

  var data = {}

  describe('.upsertByActivity', function() {
    context('valid parameters', function() {
      it('should create', function() {
        var userId1 = mongoose.Types.ObjectId()
        var userId2 = mongoose.Types.ObjectId()
        var userId3 = mongoose.Types.ObjectId()

        var targetId = mongoose.Types.ObjectId()

        var sameActivityUsers = [userId1, userId2, userId3]

        var activity = {
          user: userId1,
          targetModel: 'Page',
          target: targetId,
          action: 'COMMENT',
        }

        return Notification.upsertByActivity(userId1, sameActivityUsers, activity)
          .then(function(notification) {
            expect(notification.user.toString()).to.be.equal(userId1.toString())
            expect(notification.targetModel).to.be.equal('Page')
            expect(notification.target.toString()).to.be.equal(targetId.toString())
            expect(notification.action).to.be.equal('COMMENT')
            expect(notification.isRead).to.be.equal(false)
            expect(notification.activities).to.be.length(3)
          })
          .catch(function(err) {
            throw new Error(err)
          })
      })
    })

    context('invalid parameters', function() {
      it('should create', function() {
        var userId1 = mongoose.Types.ObjectId()
        var userId2 = mongoose.Types.ObjectId()
        var userId3 = mongoose.Types.ObjectId()

        var targetId = mongoose.Types.ObjectId()

        var sameActivityUsers = [userId1, userId2, userId3]

        var activity = {
          user: userId1,
          targetModel: 'Page2', // invalid
          target: targetId,
          action: 'COMMENT',
        }

        return Notification.upsertByActivity(userId1, sameActivityUsers, activity).then(
          function(notification) {
            throw new Error('validation not work')
          },
          function(err) {
            expect(err.message === 'Notification validation failed')
          },
        )
      })
    })
  })
})
