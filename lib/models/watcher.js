module.exports = function(crowi) {
  // const debug = require('debug')('crowi:models:watcher')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const ActivityDefine = require('../util/activityDefine')()
  const STATUS_WATCH = 'WATCH'
  const STATUS_IGNORE = 'IGNORE'
  const STATUSES = [STATUS_WATCH, STATUS_IGNORE]

  const watcherSchema = new mongoose.Schema({
    user: {
      type: ObjectId,
      ref: 'User',
      index: true,
      required: true,
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
    status: {
      type: String,
      require: true,
      enum: STATUSES,
    },
    createdAt: { type: Date, default: Date.now },
  })

  watcherSchema.methods.isWatching = function() {
    return this.status === STATUS_WATCH
  }

  watcherSchema.methods.isIgnoring = function() {
    return this.status === STATUS_IGNORE
  }

  watcherSchema.statics.findByUserIdAndTargetId = function(userId, targetId) {
    return this.findOne({ user: userId, target: targetId })
  }

  watcherSchema.statics.upsertWatcher = function(user, targetModel, target, status) {
    const Watcher = crowi.model('Watcher')
    const query = { user, targetModel, target }
    const doc = { ...query, status }
    const options = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    return Watcher.findOneAndUpdate(query, doc, options)
  }

  watcherSchema.statics.watchByPageId = function(user, pageId, status) {
    return this.upsertWatcher(user, 'Page', pageId, status)
  }

  watcherSchema.statics.getWatchers = async function(target) {
    const Watcher = crowi.model('Watcher')
    return Watcher.find({ target, status: STATUS_WATCH }).distinct('user')
  }

  watcherSchema.statics.getIgnorers = async function(target) {
    const Watcher = crowi.model('Watcher')
    return Watcher.find({ target, status: STATUS_IGNORE }).distinct('user')
  }

  watcherSchema.statics.STATUS_WATCH = STATUS_WATCH
  watcherSchema.statics.STATUS_IGNORE = STATUS_IGNORE

  return mongoose.model('Watcher', watcherSchema)
}
