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
    return page.match(/((?:^|[^a-zA-Z0-9_＠!@#$%&*`]))((?:(?:@|＠)(?!\/))([a-zA-Z0-9-_.]+))(?:\b(?!@|＠)|$)/gm)
  }

  mentionSchema.statics.createByPage = async function(page) {
    const Mention = this
    const User = crowi.model('User')

    if (!(page.revision && page.revision.body)) {
      throw new Error('no revision/body in page')
    }

    const { revision } = page
    const { body } = page.revision

    const userNames = this.getUserNames(body).map(username => username.replace('@', ''))
    const mentions = await User.find({ username: { $in: userNames } })

    return Mention.create({
      creator: revision.author,
      page: page._id,
      revision: revision._id,
      mentions,
    })
  }

  /**
   * post save hook
   */
  mentionSchema.post('save', async mention => {
    const Activity = crowi.model('Activity')
    const activityLog = await Activity.createByMention(mention)
    debug('Activity created', activityLog)
  })
  mentionSchema.methods.getNotificationTargetUsers = function() {
    const { user } = this
    return [user]
  }

  return mongoose.model('Mention', mentionSchema)
}
