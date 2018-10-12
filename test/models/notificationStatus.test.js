var chai = require('chai')

var expect = chai.expect

var sinon = require('sinon')

var sinonChai = require('sinon-chai')

var utils = require('../utils.js')
chai.use(sinonChai)

describe('NotificationStatus', function() {
  var Comment = utils.models.Comment
  var NotificationStatus = utils.models.NotificationStatus
  var mongoose = utils.mongoose
  var conn = utils.mongoose.connection

  describe('.upsertByNotification', function() {
    context('valid parameters', function() {
      it('should create', function() {
        var userId1 = mongoose.Types.ObjectId()
        var count = 3

        return NotificationStatus.upsertByNotification(userId1, count)
          .then(function(notificationStatus) {
            expect(notificationStatus.user.toString()).to.be.equal(userId1.toString())
            expect(notificationStatus.count).to.be.equal(3)
            expect(notificationStatus.isRead).to.be.equal(false)
          })
          .catch(function(err) {
            throw new Error(err)
          })
      })
    })
  })
})
