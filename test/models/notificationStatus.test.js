var chai = require('chai')
  , expect = chai.expect
  , sinon = require('sinon')
  , sinonChai = require('sinon-chai')
  , Promise = require('bluebird')
  , utils = require('../utils.js')
  ;
chai.use(sinonChai);

describe('NotificationStatus', function () {
  var Comment = utils.models.Comment;
  var NotificationStatus = utils.models.NotificationStatus;
  var mongoose = utils.mongoose;
  var conn   = utils.mongoose.connection;

  describe('.upsertByNotification', function() {
    context('valid parameters', function() {
      it('should create', function() {
        var user_id_1 = mongoose.Types.ObjectId();
        var count = 3;

        return NotificationStatus.upsertByNotification(user_id_1, count)
          .then(function(notificationStatus) {
            expect(notificationStatus.user.toString()).to.be.equal(user_id_1.toString());
            expect(notificationStatus.count).to.be.equal(3);
            expect(notificationStatus.isRead).to.be.equal(false);
          })
          .catch(function(err) {
            throw new Error(err);
          });
        ;
      });
    });
  });
});
