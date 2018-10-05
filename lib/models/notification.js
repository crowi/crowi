module.exports = function(crowi) {
  'use strict'

  const debug = require('debug')('crowi:models:notification')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const ActivityDefine = require('../util/activityDefine')()

  const notificationSchema = new mongoose.Schema({
    user: {
      type: ObjectId,
      ref: 'User',
      index: true,
      require: true,
    },
    targetModel: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportTargetModelNames(),
    },
    target: {
      type: ObjectId,
      refPath: 'targetModel',
      require: true,
    },
    action: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportActionNames(),
    },
    activities: [
      {
        type: ObjectId,
        ref: 'Activity',
      },
    ],
    isRead: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
  notificationSchema.virtual('actionUsers').get(function() {
    const Activity = crowi.model('Activity')
    return Activity.getActionUsersFromActivities(this.activities)
  })
  const transform = (doc, ret) => {
    delete ret.activities
  }
  notificationSchema.set('toObject', { virtuals: true, transform })
  notificationSchema.set('toJSON', { virtuals: true, transform })
  notificationSchema.index({ user: 1, target: 1, action: 1, createdAt: 1 }, { unique: true })

  notificationSchema.statics.findLatestNotificationsByUser = function(user, limit, offset) {
    const Notification = this
    limit = limit || 10

    return new Promise(function(resolve, reject) {
      Notification.find({ user: user })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate(['user', 'target'])
        .populate({ path: 'activities', populate: { path: 'user' } })
        .exec(function(err, notifications) {
          if (err) {
            reject(err)
          }

          // debug('notifications', notifications);

          resolve(notifications)
        })
    })
  }

  notificationSchema.statics.upsertByActivity = function(user, sameActivities, activity) {
    const Notification = this
    const { targetModel, target, action } = activity

    return new Promise(function(resolve, reject) {
      const query = { user, target, action }
      const parameters = {
        user,
        targetModel,
        target,
        action,
        activities: sameActivities,
        isRead: false,
        createdAt: Date.now(),
      }

      const options = {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      }

      Notification.findOneAndUpdate(query, parameters, options, function(err, notification) {
        if (err) {
          debug(err)
          reject(err)
        }

        if (typeof notification !== 'undefined') {
          Notification.upsertPostHook(notification.user)
        }

        resolve(notification)
      })
    })
  }

  notificationSchema.statics.removeActivity = async function(activity) {
    const Notification = this
    const NotificationStatus = crowi.model('NotificationStatus')
    const { _id, target, action } = activity
    const query = { target, action }
    const parameters = { $pull: { activities: _id } }
    const options = { multi: true }

    const result = await Notification.update(query, parameters, options)

    const updated = await Notification.find(query)
    const users = updated.map(({ user }) => user)

    await Promise.all([NotificationStatus.updateUnreadCountByUsers(users), Notification.removeEmpty()])
    return result
  }

  notificationSchema.statics.removeEmpty = function() {
    const Notification = this
    return Notification.remove({ activities: { $size: 0 } })
  }

  notificationSchema.statics.read = function(user, id) {
    const Notification = this

    const query = {
      _id: id,
      user: user._id,
    }

    const parameters = {
      isRead: true,
    }

    const options = {
      new: true,
    }

    return new Promise(function(resolve, reject) {
      Notification.findOneAndUpdate(query, parameters, options).exec(function(err, notification) {
        if (err) {
          reject(err)
        }

        if (typeof notification !== 'undefined') {
          Notification.upsertPostHook(notification.user)
        }

        resolve(notification)
      })
    })
  }

  notificationSchema.statics.getUnreadCountByUser = function(user) {
    const Notification = this

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
        isRead: false,
      }

      Notification.count(query).exec(function(err, count) {
        if (err) {
          debug(err)
          reject(err)
        }

        debug('getUnreadCount', count)
        resolve(count)
      })
    })
  }

  /**
   * upsert post hook
   *
   * Why did not use mongoose's 'post' hook?
   * - Because findOneAndUpdate() could not use 'post' hook
   */
  notificationSchema.statics.upsertPostHook = function(user) {
    const NotificationStatus = crowi.model('NotificationStatus')
    NotificationStatus.updateUnreadCountByUser(user)
  }

  return mongoose.model('Notification', notificationSchema)
}
