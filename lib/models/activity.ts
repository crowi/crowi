import Crowi from 'server/crowi'
import { DeleteWriteOpResultObject } from 'mongodb'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'
import ActivityDefine from 'server/util/activityDefine'

export interface ActivityDocument extends Document {
  _id: Types.ObjectId
  user: Types.ObjectId | any
  targetModel: string
  target: string
  action: string
  event: Types.ObjectId
  eventModel: string
  createdAt: Date

  getNotificationTargetUsers(): Promise<any[]>
}

export interface ActivityModel extends Model<ActivityDocument> {
  createByParameters(parameters: any): Promise<ActivityDocument>
  removeByParameters(parameters: any): any
  createByPageComment(comment: any): Promise<ActivityDocument>
  removeByPageCommentDelete(comment: any): Promise<DeleteWriteOpResultObject['result']>
  createByPageLike(page: any, user: any): Promise<ActivityDocument>
  removeByPageUnlike(page: any, user: any): Promise<DeleteWriteOpResultObject['result']>
  removeByPage(page: any): Promise<DeleteWriteOpResultObject['result']>
  findByUser(user: any): Promise<ActivityDocument[]>
  getActionUsersFromActivities(activities: ActivityDocument[]): any[]
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:activity')
  const activityEvent = crowi.event('Activity')

  // TODO: add revision id
  const activitySchema = new Schema<ActivityDocument, ActivityModel>({
    user: {
      type: Schema.Types.ObjectId,
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
      type: Schema.Types.ObjectId,
      refPath: 'targetModel',
      require: true,
    },
    action: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportActionNames(),
    },
    event: {
      type: Schema.Types.ObjectId,
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
  activitySchema.index({ user: 1, target: 1, action: 1, createdAt: 1 }, { unique: true })

  /**
   * @param {object} parameters
   * @return {Promise}
   */
  activitySchema.statics.createByParameters = function (parameters) {
    return Activity.create(parameters)
  }

  /**
   * @param {object} parameters
   */
  activitySchema.statics.removeByParameters = async function (parameters) {
    const activity = await Activity.findOne(parameters)
    activityEvent.emit('remove', activity)

    return Activity.deleteMany(parameters).exec()
  }

  /**
   * @param {Comment} comment
   * @return {Promise}
   */
  activitySchema.statics.createByPageComment = function (comment) {
    const parameters = {
      user: comment.creator,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: comment.page,
      eventModel: ActivityDefine.MODEL_COMMENT,
      event: comment._id,
      action: ActivityDefine.ACTION_COMMENT,
    }

    return this.createByParameters(parameters)
  }

  /**
   * @param {Comment} comment
   * @return {Promise}
   */
  activitySchema.statics.removeByPageCommentDelete = function (comment) {
    const parameters = {
      user: comment.creator,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: comment.page,
      eventModel: ActivityDefine.MODEL_COMMENT,
      event: comment._id,
      action: ActivityDefine.ACTION_COMMENT,
    }

    return this.removeByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.createByPageLike = function (page, user) {
    const parameters = {
      user: user._id,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page,
      action: ActivityDefine.ACTION_LIKE,
    }

    return this.createByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.removeByPageUnlike = function (page, user) {
    const parameters = {
      user: user,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page,
      action: ActivityDefine.ACTION_LIKE,
    }

    return this.removeByParameters(parameters)
  }

  /**
   * @param {Page} page
   * @return {Promise}
   */
  activitySchema.statics.removeByPage = async function (page) {
    const activities = await Activity.find({ target: page })
    for (const activity of activities) {
      activityEvent.emit('remove', activity)
    }
    return Activity.deleteMany({ target: page }).exec()
  }

  /**
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.findByUser = function (user) {
    return Activity.find({ user: user }).sort({ createdAt: -1 }).exec()
  }

  activitySchema.statics.getActionUsersFromActivities = function (activities) {
    return activities.map(({ user }) => user).filter((user, i, self) => self.indexOf(user) === i)
  }

  activitySchema.methods.getNotificationTargetUsers = async function () {
    const User = crowi.model('User')
    const Watcher = crowi.model('Watcher')
    const { user: actionUser, targetModel, target } = this

    const model: any = await this.model(targetModel).findById(target)
    const [targetUsers, watchUsers, ignoreUsers] = await Promise.all([
      model.getNotificationTargetUsers(),
      Watcher.getWatchers((target as any) as Types.ObjectId),
      Watcher.getIgnorers((target as any) as Types.ObjectId),
    ])

    const unique = (array) => Object.values(array.reduce((objects, object) => ({ ...objects, [object.toString()]: object }), {}))
    const filter = (array, pull) => {
      const ids = pull.map((object) => object.toString())
      return array.filter((object) => !ids.includes(object.toString()))
    }
    const notificationUsers = filter(unique([...targetUsers, ...watchUsers]), [...ignoreUsers, actionUser])
    const activeNotificationUsers = await User.find({
      _id: { $in: notificationUsers },
      status: User.STATUS_ACTIVE,
    }).distinct('_id')
    return activeNotificationUsers
  }

  /**
   * saved hook
   */
  activitySchema.post('save', async function (savedActivity: ActivityDocument) {
    const Notification = crowi.model('Notification')
    try {
      const notificationUsers = await savedActivity.getNotificationTargetUsers()

      return Promise.all(notificationUsers.map((user) => Notification.upsertByActivity(user, savedActivity)))
    } catch (err) {
      debug(err)
    }
  })

  // because mongoose's 'remove' hook fired only when remove by a method of Document (not by a Model method)
  // move 'save' hook from mongoose's events to activityEvent if I have a time.
  activityEvent.on('remove', async function (activity: ActivityDocument) {
    const Notification = crowi.model('Notification')

    try {
      await Notification.removeActivity(activity)
    } catch (err) {
      debug(err)
    }
  })

  const Activity = model<ActivityDocument, ActivityModel>('Activity', activitySchema)

  return Activity
}
