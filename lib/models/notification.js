module.exports = function(crowi) {
  'use strict'

  const debug = require('debug')('crowi:models:notification')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const ActivityDefine = require('../util/activityDefine')()
  const STATUS_UNREAD = 'UNREAD'
  const STATUS_UNOPENED = 'UNOPENED'
  const STATUS_OPENED = 'OPENED'
  const STATUSES = [STATUS_UNREAD, STATUS_UNOPENED, STATUS_OPENED]
  const notificationEvent = crowi.event('Notification')

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
    status: {
      type: String,
      default: STATUS_UNREAD,
      enum: STATUSES,
      index: true,
      require: true,
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
        status: STATUS_UNREAD,
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

        if (notification !== undefined) {
          notificationEvent.emit('update', notification.user)
        }

        resolve(notification)
      })
    })
  }

  notificationSchema.statics.removeActivity = async function(activity) {
    const Notification = this
    const { _id, target, action } = activity
    const query = { target, action }
    const parameters = { $pull: { activities: _id } }
    const options = { multi: true }

    const result = await Notification.update(query, parameters, options)

    await Notification.removeEmpty()
    return result
  }

  notificationSchema.statics.removeEmpty = function() {
    const Notification = this
    return Notification.remove({ activities: { $size: 0 } })
  }

  notificationSchema.statics.read = async function(user) {
    const Notification = this
    const query = { user, status: STATUS_UNREAD }
    const parameters = { status: STATUS_UNOPENED }
    const options = { multi: true }

    return Notification.update(query, parameters, options)
  }

  notificationSchema.statics.open = async function(user, id) {
    const Notification = this
    const query = { _id: id, user: user._id }
    const parameters = { status: STATUS_OPENED }
    const options = { new: true }

    const notification = await Notification.findOneAndUpdate(query, parameters, options)
    if (notification !== undefined) {
      notificationEvent.emit('update', notification.user)
    }
    return notification
  }

  notificationSchema.statics.getUnreadCountByUser = async function(user) {
    const Notification = this
    const query = { user, status: STATUS_UNREAD }

    try {
      const count = Notification.count(query)
      debug('getUnreadCount', count)
      return count
    } catch (err) {
      debug(err)
      throw err
    }
  }

  notificationEvent.on('update', user => {
    crowi.getIo().sockets.emit('notification updated', { user })
  })

  notificationSchema.statics.STATUS_UNOPENED = STATUS_UNOPENED
  notificationSchema.statics.STATUS_UNREAD = STATUS_UNREAD
  notificationSchema.statics.STATUS_OPENED = STATUS_OPENED

  return mongoose.model('Notification', notificationSchema)
}
