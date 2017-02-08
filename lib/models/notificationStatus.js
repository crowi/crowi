module.exports = function(crowi) {
  'use strict';

  const debug    = require('debug')('crowi:models:notification-status');
  const mongoose = require('mongoose');
  const ObjectId = mongoose.Schema.Types.ObjectId;

  const notificationStatusSchema = new mongoose.Schema({
    user: {
      type: ObjectId,
      ref: 'User',
      index: true,
      require: true,
    },
    count: {
      type: Number,
      require: true,
      default: 0,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  });

  notificationStatusSchema.statics.findByUser = function(user) {
    const NotifiationStatus = this;

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      };

      NotifiationStatus
        .findOne(query)
        .exec(function(err, notificationStatus) {
          if (err) {
            reject(err);
          }

          resolve(notificationStatus);
        })
      ;
    });
  };

  notificationStatusSchema.statics.upsertByNotification = function(user, count) {
    const NotifiationStatus = this;

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      };

      const parameters = {
        user: user,
        count: count,
        isRead: false,
      };

      const options = {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      };

      NotifiationStatus.findOneAndUpdate(query, parameters, options, function(err, notificationStatus) {
        if (err) {
          reject(err);
        }

        crowi.getIo().sockets.emit('notification updated', {status: notificationStatus});

        debug(notificationStatus);
        resolve(notificationStatus);
      });
    });
  };

  notificationStatusSchema.statics.updateIsReadFlag = function(user, flag) {
    flag = flag || false;

    const NotifiationStatus = this;

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      };

      const parameters = {
        isRead: flag,
      };

      const options = {
        upsert: false,
        new: true,
      };

      NotifiationStatus
        .findOneAndUpdate(query, parameters, options)
        .exec(function(err, notificationStatus) {
          if (err) {
            reject(err);
          }

          resolve(notificationStatus);
        })
      ;
    });
  };

  return mongoose.model('NotifiationStatus', notificationStatusSchema);
}
