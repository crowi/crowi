import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, Query, model, QueryOptions, UpdateQuery } from 'mongoose'
import Debug from 'debug'
import { subDays } from 'date-fns'
import ActivityDefine from 'server/util/activityDefine'
import { ActivityDocument } from './activity'
import { UserDocument } from './user'

export const NotificationStatus = {
  Unread: 'UNREAD',
  Unopened: 'UNOPENED',
  Opened: 'OPENED',
} as const
export type NotificationStatusType = typeof NotificationStatus[keyof typeof NotificationStatus]

export interface NotificationDocument extends Document {
  _id: Types.ObjectId
  user: Types.ObjectId
  targetModel: string
  target: Types.ObjectId
  action: string
  activities: Types.ObjectId[]
  status: NotificationStatusType
  createdAt: Date
}

export interface NotificationModel extends Model<NotificationDocument> {
  findLatestNotificationsByUser(user: Types.ObjectId, skip: number, offset: number): Promise<NotificationDocument[]>
  upsertByActivity(user: Types.ObjectId, activity: ActivityDocument, createdAt?: Date | null): Promise<NotificationDocument | null>
  removeActivity(activity: any): any
  removeEmpty(): Promise<Query<any, NotificationDocument>>
  read(user: UserDocument): Promise<Query<any, NotificationDocument>>
  open(user: UserDocument, id: Types.ObjectId): Promise<NotificationDocument | null>
  getUnreadCountByUser(user: Types.ObjectId): Promise<number | undefined>
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:notification')
  const notificationEvent = crowi.event('Notification')

  const notificationSchema = new Schema<NotificationDocument, NotificationModel>({
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
    activities: {
      type: [Schema.Types.ObjectId],
      ref: 'Activity',
    },
    status: {
      type: String,
      default: NotificationStatus.Unread,
      enum: Object.values(NotificationStatus),
      index: true,
      require: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
  notificationSchema.virtual('actionUsers').get(function (this: NotificationDocument) {
    const Activity = crowi.model('Activity')
    return Activity.getActionUsersFromActivities(this.activities as any as ActivityDocument[])
  })
  const transform = (doc, ret) => {
    // delete ret.activities
  }
  notificationSchema.set('toObject', { virtuals: true, transform })
  notificationSchema.set('toJSON', { virtuals: true, transform })
  notificationSchema.index({ user: 1, target: 1, action: 1, createdAt: 1 })

  notificationSchema.statics.findLatestNotificationsByUser = function (user, limit, offset) {
    limit = limit || 10

    return Notification.find({ user })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate(['user', 'target'])
      .populate({ path: 'activities', populate: { path: 'user' } })
      .exec()
  }

  notificationSchema.statics.upsertByActivity = async function (user: UserDocument, activity: ActivityDocument, createdAt = null) {
    const { _id: activityId, targetModel, target, action } = activity

    const now = createdAt || Date.now()
    const lastWeek = subDays(now, 7)
    const query = { user, target, action, createdAt: { $gt: lastWeek } }
    const parameters: UpdateQuery<NotificationDocument> = {
      user,
      targetModel,
      target,
      action,
      status: NotificationStatus.Unread,
      createdAt: now,
      // @ts-ignore
      $addToSet: { activities: activityId },
    }

    const options: QueryOptions = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    }

    const notification = await Notification.findOneAndUpdate(query, parameters, options)

    if (notification) {
      notificationEvent.emit('update', notification.user)
    }

    return notification
  }

  notificationSchema.statics.removeActivity = async function (activity: ActivityDocument) {
    const { _id, target, action } = activity
    const query = { target, action }
    // @ts-ignore
    const parameters: UpdateQuery<NotificationDocument> = { $pull: { activities: _id } }

    const result = await Notification.updateMany(query, parameters)

    await Notification.removeEmpty()
    return result
  }

  notificationSchema.statics.removeEmpty = async function () {
    return Notification.deleteMany({ activities: { $size: 0 } })
  }

  notificationSchema.statics.read = async function (user) {
    const query = { user, status: NotificationStatus.Unread }
    const parameters = { status: NotificationStatus.Unopened }

    return Notification.updateMany(query, parameters)
  }

  notificationSchema.statics.open = async function (user, id) {
    const query = { _id: id, user: user._id }
    const parameters = { status: NotificationStatus.Opened }
    const options = { new: true }

    const notification = await Notification.findOneAndUpdate(query, parameters, options)
    if (notification) {
      notificationEvent.emit('update', notification.user)
    }
    return notification
  }

  notificationSchema.statics.getUnreadCountByUser = async function (user) {
    const query = { user, status: NotificationStatus.Unread }

    try {
      const count = await Notification.countDocuments(query)

      return count
    } catch (err) {
      debug('Error on getUnreadCountByUser', err)
      throw err
    }
  }

  notificationEvent.on('update', (user) => {
    const io = crowi.getIo()
    if (io) {
      io.sockets.emit('notification updated', { user })
    }
  })

  const Notification = model<NotificationDocument, NotificationModel>('Notification', notificationSchema)

  return Notification
}
