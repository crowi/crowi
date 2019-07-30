import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, Query, model } from 'mongoose'
import Debug from 'debug'
import { ActivityDocument } from './activity'
import { UserDocument } from './user'

const STATUS_UNREAD = 'UNREAD'
const STATUS_UNOPENED = 'UNOPENED'
const STATUS_OPENED = 'OPENED'
const STATUSES = [STATUS_UNREAD, STATUS_UNOPENED, STATUS_OPENED]

export interface NotificationDocument extends Document {
  user: Types.ObjectId
  targetModel: string
  target: Types.ObjectId
  action: string
  activities: Types.ObjectId[]
  status: string
  createdAt: Date
}

export interface NotificationModel extends Model<NotificationDocument> {
  findLatestNotificationsByUser(user: Types.ObjectId, skip: number, offset: number): Promise<NotificationDocument[]>
  upsertByActivity(user: Types.ObjectId, sameActivities: Types.ObjectId[], activity: any): Promise<NotificationDocument | null>
  removeActivity(activity: any): any
  removeEmpty(): Query<any>
  read(user: UserDocument): Promise<Query<any>>
  open(user: UserDocument, id: Types.ObjectId): Promise<NotificationDocument | null>
  getUnreadCountByUser(user: Types.ObjectId): Promise<number | undefined>

  STATUS_UNREAD: string
  STATUS_UNOPENED: string
  STATUS_OPENED: string
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:notification')
  const ActivityDefine = require('../util/activityDefine')()
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
    activities: [
      {
        type: Schema.Types.ObjectId,
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
  notificationSchema.virtual('actionUsers').get(function(this: NotificationDocument) {
    const Activity = crowi.model('Activity')
    return Activity.getActionUsersFromActivities((this.activities as any) as ActivityDocument[])
  })
  const transform = (doc, ret) => {
    delete ret.activities
  }
  notificationSchema.set('toObject', { virtuals: true, transform })
  notificationSchema.set('toJSON', { virtuals: true, transform })
  notificationSchema.index({ user: 1, target: 1, action: 1, createdAt: 1 }, { unique: true })

  const Notification = model<NotificationDocument, NotificationModel>('Notification', notificationSchema)

  notificationSchema.statics.findLatestNotificationsByUser = function(user, limit, offset) {
    limit = limit || 10

    return Notification.find({ user })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate(['user', 'target'])
      .populate({ path: 'activities', populate: { path: 'user' } })
      .exec()
  }

  notificationSchema.statics.upsertByActivity = async function(user, sameActivities, activity) {
    const { targetModel, target, action } = activity

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

    const notification = await Notification.findOneAndUpdate(query, parameters, options)

    if (notification) {
      notificationEvent.emit('update', notification.user)
    }

    return notification
  }

  notificationSchema.statics.removeActivity = async function(activity) {
    const { _id, target, action } = activity
    const query = { target, action }
    const parameters = { $pull: { activities: _id } }
    const options = { multi: true }

    const result = await Notification.update(query, parameters, options)

    await Notification.removeEmpty()
    return result
  }

  notificationSchema.statics.removeEmpty = function() {
    return Notification.remove({ activities: { $size: 0 } })
  }

  notificationSchema.statics.read = async function(user) {
    const query = { user, status: STATUS_UNREAD }
    const parameters = { status: STATUS_UNOPENED }
    const options = { multi: true }

    return Notification.update(query, parameters, options)
  }

  notificationSchema.statics.open = async function(user, id) {
    const query = { _id: id, user: user._id }
    const parameters = { status: STATUS_OPENED }
    const options = { new: true }

    const notification = await Notification.findOneAndUpdate(query, parameters, options)
    if (notification) {
      notificationEvent.emit('update', notification.user)
    }
    return notification
  }

  notificationSchema.statics.getUnreadCountByUser = async function(user) {
    const query = { user, status: STATUS_UNREAD }

    try {
      const count = await Notification.count(query)

      return count
    } catch (err) {
      debug('Error on getUnreadCountByUser', err)
      throw err
    }
  }

  notificationEvent.on('update', user => {
    crowi.getIo().sockets.emit('notification updated', { user })
  })

  notificationSchema.statics.STATUS_UNOPENED = STATUS_UNOPENED
  notificationSchema.statics.STATUS_UNREAD = STATUS_UNREAD
  notificationSchema.statics.STATUS_OPENED = STATUS_OPENED

  return Notification
}
