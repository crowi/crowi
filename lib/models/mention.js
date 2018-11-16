module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:mention')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const mentionSchema = new mongoose.Schema({
    creator: { type: ObjectId, ref: 'User', index: true },
    page: { type: ObjectId, ref: 'Page', index: true },
    revision: { type: ObjectId, ref: 'Revision', index: true },
    user: { type: ObjectId, ref: 'User', index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now, index: true },
  })
  mentionSchema.index({ revision: 1, user: 1, createdAt: 1 }, { unique: true })

  mentionSchema.statics.getUserNames = page => {
    return page.match(/((?:^|[^a-zA-Z0-9_＠!@#$%&*`\n]))((?:(?:@|＠)(?!\/))([a-zA-Z0-9-_.]+))(?:\b(?!@|＠)|$)/gm) || []
  }

  mentionSchema.statics.findUsersByRevisionId = function(revision) {
    const Mention = this
    return Mention.find({ revision }).distinct('user')
  }

  mentionSchema.statics.findUsersByRevisionBody = async function(body) {
    const User = crowi.model('User')

    const userNames = this.getUserNames(body).map(username => username.replace('@', ''))

    if (userNames.length) {
      return User.find({ username: { $in: userNames } }).distinct('_id')
    }

    return []
  }

  mentionSchema.statics.findPreviousUsersByPage = async function(page) {
    const Mention = this
    const Revision = crowi.model('Revision')
    const { path } = page

    const previousRevision = await Revision.findPreviousRevision(path)
    if (previousRevision) {
      const { _id: revisionId, body } = previousRevision

      const users = await Mention.findUsersByRevisionId(revisionId)
      if (users.length) {
        return users
      }

      return Mention.findUsersByRevisionBody(body)
    }

    return []
  }

  mentionSchema.statics.diffUsers = function(previous, current) {
    const diff = array => x => !new Set(array.map(v => v.toString())).has(x.toString())

    const created = current.filter(diff(previous))
    const removed = previous.filter(diff(current))
    return { created, removed }
  }

  mentionSchema.statics.upsertByPage = async function(page) {
    const Mention = this

    if (!(page.revision && page.revision.body)) {
      throw new Error('no revision/body in page')
    }

    const { _id: pageId, revision } = page
    const { _id: revisionId, author: creator, body } = revision

    const [previousUsers, currentUsers] = await Promise.all([Mention.findPreviousUsersByPage(page), Mention.findUsersByRevisionBody(body)])
    const { created, removed } = Mention.diffUsers(previousUsers, currentUsers)

    debug({ body })
    debug({ previousUsers, currentUsers, created, removed })

    if (currentUsers.length) {
      const options = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      const promises = currentUsers.map(user => {
        const query = { creator, page: pageId, revision: revisionId, user }
        const doc = query
        return Mention.findOneAndUpdate(query, doc, options)
      })
      const mentions = await Promise.all(promises)

      Mention.createActivitiesByPageIdAndUsers(pageId, created)
      Mention.removeActivitiesByPageIdAndUsers(pageId, removed)

      return mentions
    }

    return []
  }

  mentionSchema.statics.removeByPage = async function(page) {
    const Mention = this
    return Mention.remove({ page })
  }

  mentionSchema.statics.createActivitiesByPageIdAndUsers = async function(page, users) {
    const Mention = this
    const Activity = crowi.model('Activity')

    if (users.length) {
      const mentions = await Mention.find({ page, user: { $in: users } })
      const promises = mentions.map(mention => Activity.createByMention(mention))

      return Promise.all(promises)
    }
    return null
  }

  mentionSchema.statics.removeActivitiesByPageIdAndUsers = async function(page, users) {
    const Mention = this
    const Activity = crowi.model('Activity')

    if (users.length) {
      const mentions = await Mention.find({ page, user: { $in: users } })
      const promises = mentions.map(mention => Activity.removeByMention(mention))

      return Promise.all(promises)
    }
    return null
  }

  mentionSchema.methods.getNotificationTargetUsers = function() {
    const { user } = this
    return [user]
  }

  return mongoose.model('Mention', mentionSchema)
}
