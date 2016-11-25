module.exports = function(crowi) {
  'use strict';

  const debug    = require('debug')('crowi:models:notification');
  const mongoose = require('mongoose');
  const ObjectId = mongoose.Schema.Types.ObjectId;
  const ActivityDefine = require('../util/activityDefine')();

  const notificationSchema = new mongoose.Schema({
    user: {
      type: ObjectId,
      ref: 'User',
      index: true,
      require: true,
    },
    target_model: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportModelNames(),
    },
    target: {
      type: ObjectId,
      refPath: 'target_model',
      require: true,
    },
    action: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportActionNames(),
    },
    latest_action_users: [
      {
        type: ObjectId,
        ref: 'User',
      }
    ],
    action_users_count: {
      type: Number,
      require: true,
    },
    is_read: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  });
  notificationSchema.index({user: 1, target: 1, action: 1, createdAt: 1}, {unique: true});

  notificationSchema.statics.findLatestNotificationsByUser = function(user, limit) {
    const Notification = this;
    limit = limit || 10;

    debug('user', user);
    debug('limit', limit);

    return new Promise(function(resolve, reject) {
      Notification
        .find({user: user})
        .sort({createdAt: -1})
        .limit(limit)
        .populate(['user', 'target', 'latest_action_users'])
        .exec(function(err, notifications) {
          if (err) {
            reject(err);
          }

          debug('notifications', notifications);

          resolve(notifications);
        });
    });
  };

  notificationSchema.statics.upsertByActivity = function(user, sameActivityUsers, activity) {
    const Notification = this;

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
        target: activity.target,
        action: activity.action,
      };

      const parameters = {
        user: user,
        target_model: activity.target_model,
        target: activity.target,
        action: activity.action,
        latest_action_users: sameActivityUsers.slice(0, 3),
        action_users_count: sameActivityUsers.length,
        is_read: false,
        createdAt: Date.now(),
      };

      const options = {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      };

      Notification.findOneAndUpdate(query, parameters, options, function(err, notification) {
        if (err) {
          debug(err);
          reject(err);
        }

        Notification.upsertPostHook(notification);

        resolve(notification);
      });
    });
  };

  notificationSchema.statics.read = function(user, id) {
    const Notification = this;

    const query = {
      _id: id,
      user: user._id,
    };

    const parameters = {
      is_read: true,
    };

    const options = {
      new: true,
    };

    return new Promise(function(resolve, reject) {
      Notification
        .findOneAndUpdate(query, parameters, options)
        .exec(function(err, notification) {
          if (err) {
            reject(err);
          }

          Notification.upsertPostHook(notification);

          resolve(notification);
        })
      ;
    });
  };

  notificationSchema.statics.getUnreadCountByUser = function(user) {
    const Notification = this;

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
        is_read: false,
      };

      Notification
        .count(query)
        .exec(function(err, count) {
          if (err) {
            debug(err);
            reject(err);
          }

          debug('getUnreaCount', count);
          resolve(count);
        })
      ;
    });
  };

  /**
   * upsert post hook
   *
   * Why did not use mongoose's 'post' hook?
   * - Because findOneAndUpdate() could not use 'post' hook
   */
  notificationSchema.statics.upsertPostHook = function(notification) {
    const Notification = this;
    const NotificationStatus = crowi.model('NotificationStatus');

    Promise
      .resolve(Notification.getUnreadCountByUser(notification.user))
      .then(function(count) {
        debug('unread count', count);
        return NotificationStatus.upsertByNotification(notification.user, count);
      })
      .then(function(savedNotificationStatus) {
        debug('saved NotificationStatus', savedNotificationStatus);
      })
      .catch(function(err) {
        debug('Error notificationStatus', err);
      })
    ;
  };

  return mongoose.model('Notification', notificationSchema);
}
