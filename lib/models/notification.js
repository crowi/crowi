module.exports = function(crowi) {
  var debug = require('debug')('crowi:models:page');
  var mongoose = require('mongoose');
  var ObjectId = mongoose.Schema.Types.ObjectId;

  var TYPE_COMMENT = 'comment',
      TYPE_LIKE    = 'like';

  var MESSAGE_COMMENT = 'コメントがありました',
      MESSAGE_LIKE    = 'いいねされました';

  var notificationSchema = new mongoose.Schema({
    to: { type: ObjectId, ref: 'User', index: true, require: true },
    from: { type: ObjectId, ref: 'User', index: true, require: true },
    type: { type: String, require: true },
    page: { type: ObjectId, ref: 'Page' },
    is_read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  });

  /**
   * @param {Page} page
   * @param {Comment} comment
   * @return {Notification|null}
   */
  notificationSchema.statics.createByPageAndComment = function(page, comment) {
    var Notification = this;

    return new Promise(function(resolve, reject) {
      // No need to send a notification when page creator add a comment.
      // if (page.creator.toString() === comment.creator.toString()) {
      //   resolve(null);
      // }

      // TODO: page.creator 以外の対象者にも Notification を追加する処理が必要
      //       - bookmarker
      //       - editor
      //       - liker
      var params = {
        to: page.creator,
        from: comment.creator,
        type: TYPE_COMMENT,
        page: page._id,
        is_read: false,
      };

      try {
        resolve(Notification.create(params));
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
   * @param {User} user
   * @return {Array} Notification[]
   */
  notificationSchema.statics.findByUser = function(user) {
    var Notification = this;

    return new Promise(function(resolve, reject) {
      Notification
        .find({to: user._id})
        .sort({createdAt: -1})
        .exec(function(err, notifications) {
          if (err) {
            return reject(err);
          }

          return resolve(notifications);
        });
    });
  };


  // notificationSchema.statics.createByComment = function(Comment) {
  //   var Notification = this;

  //   return new Promise(function(resolve, reject) {
  //     var Page = crowi.model('Page');

  //     Page.findPageById(Comment.page)
  //       .then(function(page) {
  //         var params = {
  //           to: page.creator,
  //           from: Comment.creator,
  //           type: 'comment',
  //           message: 'コメントがありました',
  //           comment: Comment._id,
  //           page: Comment.page
  //         };
  //         return Notification.create(params);
  //       })
  //       .then(function(savedNotification) {
  //         resolve(savedNotification);
  //       })
  //       .catch(function(err) {
  //         reject(err);
  //       })
  //     ;
  //   });
  // };

  // notificationSchema.statics.create = function(obj) {
  //   var Notification = this;

  //   return new Promise(function(resolve, reject) {
  //     var newNotification = new Notification;

  //     Object.keys(notificationSchema.paths).forEach(function(key) {
  //       if (key !== '_id') {
  //         if (typeof obj[key] !== 'undefined') {
  //           newNotification[key] = obj[key];
  //         }
  //       }
  //     });
  //     // newNotification.user = obj.user;
  //     // newNotification.type = obj.type;
  //     // newNotification.comment = obj.comment;
  //     // newNotification.page = obj.page;

  //     //newNotification.createdAt = Date.now();

  //     newNotification.save(function(err, notification) {
  //       if (err) {
  //         return reject(err);
  //       }

  //       return resolve(notification);
  //     });

  //   });
  // };


  return mongoose.model('Notification', notificationSchema);
}
