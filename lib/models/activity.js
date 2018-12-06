module.exports = function(crowi) {
  'use strict'

  const debug = require('debug')('crowi:models:activity')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const ActivityDefine = require('../util/activityDefine')()
  const ObjectIdsUtil = require('../util/objectIds')
  const activityEvent = crowi.event('Activity')

  // TODO: add revision id
  const activitySchema = new mongoose.Schema({
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
    event: {
      type: ObjectId,
      refPath: 'eventModel',
    },
    eventModel: {
      type: String,
      enum: ActivityDefine.getSupportEventModelNames(),
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
  activitySchema.index({ target: 1, action: 1 })
  activitySchema.index({ user: 1, target: 1, action: 1, event: 1, createdAt: 1 }, { unique: true })

  /**
   * @param {Object} parameters
   * @return {Promise}
   */
  activitySchema.statics.createByParameters = function(parameters) {
    const Activity = this

    return new Promise(function(resolve, reject) {
      try {
        resolve(Activity.create(parameters))
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * @param {Object} parameters
   */
  activitySchema.statics.removeByParameters = function(parameters) {
    const Activity = this

    return new Promise(async function(resolve, reject) {
      try {
        const activity = await Activity.findOne(parameters)
        activityEvent.emit('remove', activity)
        resolve(Activity.remove(parameters))
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * @param {Comment} comment
   * @return {Promise}
   */
  activitySchema.statics.createByPageComment = function(comment) {
    let parameters = {
      user: comment.creator,
      targetModel: ActivityDefine.MODELS.PAGE,
      target: comment.page,
      eventModel: ActivityDefine.MODELS.COMMENT,
      event: comment._id,
      action: ActivityDefine.ACTIONS.COMMENT,
    }

    return this.createByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.createByPageLike = function(page, user) {
    let parameters = {
      user: user._id,
      targetModel: ActivityDefine.MODELS.PAGE,
      target: page,
      action: ActivityDefine.ACTIONS.LIKE,
    }

    return this.createByParameters(parameters)
  }

  /**
   * @param {Mention} mention
   * @return {Promise}
   */
  activitySchema.statics.createByMention = function(mention) {
    let parameters = {
      user: mention.creator,
      targetModel: ActivityDefine.MODELS.PAGE,
      target: mention.page,
      eventModel: ActivityDefine.MODELS.MENTION,
      event: mention._id,
      action: ActivityDefine.ACTIONS.MENTION,
    }

    return this.createByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.removeByPageUnlike = function(page, user) {
    let parameters = {
      user: user,
      targetModel: ActivityDefine.MODELS.PAGE,
      target: page,
      action: ActivityDefine.ACTIONS.LIKE,
    }

    return this.removeByParameters(parameters)
  }

  /**
   * @param {Mention} mention
   * @return {Promise}
   */
  activitySchema.statics.removeByMention = function(mention) {
    let parameters = {
      user: mention.creator,
      targetModel: ActivityDefine.MODELS.PAGE,
      target: mention.page,
      eventModel: ActivityDefine.MODELS.MENTION,
      event: mention._id,
      action: ActivityDefine.ACTIONS.MENTION,
    }

    return this.removeByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @return {Promise}
   */
  activitySchema.statics.removeByPage = async function(page) {
    const Activity = this
    const activities = await Activity.find({ target: page })
    for (let activity of activities) {
      activityEvent.emit('remove', activity)
    }
    return Activity.remove({ target: page })
  }

  /**
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.findByUser = function(user) {
    let Activity = this

    return new Promise(function(resolve, reject) {
      Activity.find({ user })
        .sort({ createdAt: -1 })
        .exec(function(err, notifications) {
          if (err) {
            return reject(err)
          }

          return resolve(notifications)
        })
    })
  }

  activitySchema.statics.getActionUsersFromActivities = function(activities) {
    return activities.map(({ user }) => user).filter((user, i, self) => self.indexOf(user) === i)
  }

  activitySchema.methods.getTargetBrokerDocument = function() {
    const { targetModel, target, eventModel, event } = this

    const hasEvent = eventModel && event
    const modelName = hasEvent ? eventModel : targetModel
    const id = hasEvent ? event : target

    return this.model(modelName).findById(id)
  }

  activitySchema.methods.filterInactiveUsers = async function(users) {
    const User = crowi.model('User')
    const query = {
      _id: { $in: users },
      status: User.STATUS_ACTIVE,
    }

    return User.find(query).distinct('_id')
  }

  activitySchema.methods.getNotificationTargetUsers = async function() {
    const Watcher = crowi.model('Watcher')
    const { user: actionUser } = this

    const targetBroker = await this.getTargetBrokerDocument()
    const watcherBroker = Watcher.getWatcherBrokerDocument(this)

    const getTargets = targetBroker ? targetBroker.getNotificationTargetUsers() : []
    const getWatchers = watcherBroker ? Watcher.getWatchers(watcherBroker) : []
    const getIgnorers = watcherBroker ? Watcher.getIgnorers(watcherBroker) : []

    const [targetUsers, watchUsers, ignoreUsers] = await Promise.all([getTargets, getWatchers, getIgnorers])
    debug({ targetUsers, watchUsers, ignoreUsers })

    const notificationUsers = ObjectIdsUtil.unique(ObjectIdsUtil.difference([...targetUsers, ...watchUsers], [...ignoreUsers, actionUser]))
    const activeNotificationUsers = await this.filterInactiveUsers(notificationUsers)
    return activeNotificationUsers
  }

  /**
   * saved hook
   */
  activitySchema.post('save', async function(savedActivity) {
    const Notification = crowi.model('Notification')
    try {
      const notificationUsers = await savedActivity.getNotificationTargetUsers()

      return Promise.all(notificationUsers.map(user => Notification.upsertByActivity(user, savedActivity)))
    } catch (err) {
      debug(err)
    }
  })

  // because mongoose's 'remove' hook fired only when remove by a method of Document (not by a Model method)
  // move 'save' hook from mongoose's events to activityEvent if I have a time.
  activityEvent.on('remove', async function(activity) {
    const Notification = crowi.model('Notification')

    try {
      await Notification.removeActivity(activity)
    } catch (err) {
      debug(err)
    }
  })

  return mongoose.model('Activity', activitySchema)
}
