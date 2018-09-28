module.exports = function(crowi) {
  'use strict'

  const debug = require('debug')('crowi:models:notification-status')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId

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
  })

  notificationStatusSchema.statics.findByUser = function(user) {
    const NotificationStatus = this

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      }

      NotificationStatus.findOne(query).exec(function(err, notificationStatus) {
        if (err) {
          reject(err)
        }

        resolve(notificationStatus)
      })
    })
  }

  notificationStatusSchema.statics.upsertByNotification = function(user, count) {
    const NotificationStatus = this

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      }

      const parameters = {
        user: user,
        count: count,
        isRead: false,
      }

      const options = {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }

      NotificationStatus.findOneAndUpdate(query, parameters, options, function(err, notificationStatus) {
        if (err) {
          reject(err)
        }

        crowi.getIo().sockets.emit('notification updated', { status: notificationStatus })

        debug(notificationStatus)
        resolve(notificationStatus)
      })
    })
  }

  notificationStatusSchema.statics.updateUnreadCountByUser = async function(user) {
    const Notification = crowi.model('Notification')
    const NotificationStatus = this
    try {
      const count = await Notification.getUnreadCountByUser(user)
      const result = await NotificationStatus.upsertByNotification(user, count)
      return result
    } catch (err) {
      debug('Error notificationStatus', err)
      throw err
    }
  }

  notificationStatusSchema.statics.updateUnreadCountByUsers = async function(users) {
    if (users && users.length > 0) {
      return Promise.all(users.map(id => this.updateUnreadCountByUser(id)))
    }
  }

  notificationStatusSchema.statics.updateIsReadFlag = function(user, flag) {
    flag = flag || false

    const NotificationStatus = this

    return new Promise(function(resolve, reject) {
      const query = {
        user: user,
      }

      const parameters = {
        isRead: flag,
      }

      const options = {
        upsert: false,
        new: true,
      }

      NotificationStatus.findOneAndUpdate(query, parameters, options).exec(function(err, notificationStatus) {
        if (err) {
          reject(err)
        }

        resolve(notificationStatus)
      })
    })
  }

  return mongoose.model('NotificationStatus', notificationStatusSchema)
}
