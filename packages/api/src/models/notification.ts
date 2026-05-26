import Crowi from 'src/crowi';
import { Types, Document, Model, Schema, Query, model } from 'mongoose';
import Debug from 'debug';
import { subDays } from 'date-fns';
import type { NotificationPayload } from '@crowi/plugin-api';
import ActivityDefine from 'src/util/activityDefine';
import { NOTIFICATIONS_CHANNEL_PREFIX } from 'src/notifications/attach';
import { ActivityDocument } from './activity';
import { UserDocument } from './user';

const STATUS_UNREAD = 'UNREAD';
const STATUS_UNOPENED = 'UNOPENED';
const STATUS_OPENED = 'OPENED';
const STATUSES = [STATUS_UNREAD, STATUS_UNOPENED, STATUS_OPENED];

export interface NotificationDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  targetModel: string;
  target: Types.ObjectId;
  action: string;
  activities: Types.ObjectId[];
  status: string;
  createdAt: Date;
}

export interface NotificationModel extends Model<NotificationDocument> {
  findLatestNotificationsByUser(user: Types.ObjectId, skip: number, offset: number): Promise<NotificationDocument[]>;
  upsertByActivity(user: Types.ObjectId, activity: ActivityDocument, createdAt?: Date | null): Promise<NotificationDocument | null>;
  removeActivity(activity: any): any;
  removeEmpty(): ReturnType<typeof Model.deleteMany>;
  read(user: UserDocument): ReturnType<typeof Model.updateMany>;
  open(user: UserDocument, id: Types.ObjectId): Promise<NotificationDocument | null>;
  getUnreadCountByUser(user: Types.ObjectId): Promise<number | undefined>;

  STATUS_UNREAD: string;
  STATUS_UNOPENED: string;
  STATUS_OPENED: string;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:notification');
  const notificationEvent = crowi.event('Notification');

  const notificationSchema = new Schema<NotificationDocument, NotificationModel>({
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    targetModel: {
      type: String,
      required: true,
      enum: ActivityDefine.getSupportTargetModelNames(),
    },
    target: {
      type: Schema.Types.Mixed,
      refPath: 'targetModel',
      required: true,
    },
    action: {
      type: String,
      required: true,
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
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  });
  notificationSchema.virtual('actionUsers').get(function (this: NotificationDocument) {
    const Activity = crowi.model('Activity');
    return Activity.getActionUsersFromActivities(this.activities as any as ActivityDocument[]);
  });
  const transform = (doc, ret) => {
    // delete ret.activities
  };
  notificationSchema.set('toObject', { virtuals: true, transform });
  notificationSchema.set('toJSON', { virtuals: true, transform });
  notificationSchema.index({ user: 1, target: 1, action: 1, createdAt: 1 });

  notificationSchema.statics.findLatestNotificationsByUser = function (user, limit, offset) {
    limit = limit || 10;

    return Notification.find({ user })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate(['user', 'target'])
      .populate({ path: 'activities', populate: { path: 'user' } })
      .exec();
  };

  notificationSchema.statics.upsertByActivity = async function (user, activity, createdAt = null) {
    const { _id: activityId, targetModel, target, action } = activity;

    const now = createdAt || Date.now();
    const lastWeek = subDays(now, 7);
    const query = { user, target, action, createdAt: { $gt: lastWeek } };
    const parameters = {
      user,
      targetModel,
      target,
      action,
      status: STATUS_UNREAD,
      createdAt: now,
      $addToSet: { activities: activityId },
    };

    const options = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    };

    const notification = await Notification.findOneAndUpdate(query, parameters, options);

    if (notification) {
      notificationEvent.emit('update', notification.user);
      // RFC-0002 Phase 8: forward to registered notifier plugins (Slack /
      // Webhook / ...). Fire-and-forget per-driver: a single misbehaving
      // driver must not block the upsert or other drivers. The plugin
      // manager may not be initialised in some test paths, so we guard.
      forwardToNotifierPlugins(crowi, notification, activity);
    }

    return notification;
  };

  notificationSchema.statics.removeActivity = async function (activity) {
    const { _id, target, action } = activity;
    const query = { target, action };
    const parameters = { $pull: { activities: _id } };

    const result = await Notification.updateMany(query, parameters);

    await Notification.removeEmpty();
    return result;
  };

  notificationSchema.statics.removeEmpty = function () {
    return Notification.deleteMany({ activities: { $size: 0 } });
  };

  notificationSchema.statics.read = async function (user) {
    const query = { user, status: STATUS_UNREAD };
    const parameters = { status: STATUS_UNOPENED };

    const result = await Notification.updateMany(query, parameters);
    // Emit even when `modifiedCount === 0` — the realtime invalidation
    // tick is cheap and a mark-all-as-read with nothing to flip should
    // still tell any other tab "your notifications view is fresh now".
    notificationEvent.emit('update', user._id);
    return result;
  };

  notificationSchema.statics.open = async function (user, id) {
    const query = { _id: id, user: user._id };
    const parameters = { status: STATUS_OPENED };
    const options = { new: true };

    const notification = await Notification.findOneAndUpdate(query, parameters, options);
    if (notification) {
      notificationEvent.emit('update', notification.user);
    }
    return notification;
  };

  notificationSchema.statics.getUnreadCountByUser = async function (user) {
    const query = { user, status: STATUS_UNREAD };

    try {
      const count = await Notification.countDocuments(query);

      return count;
    } catch (err) {
      debug('Error on getUnreadCountByUser', err);
      throw err;
    }
  };

  notificationEvent.on('update', (user) => {
    // Realtime invalidation fan-out: publish a per-user "changed" tick
    // on the user's notifications Redis channel so the browser's
    // `/notifications/<userId>` WebSocket can drop its 30-second
    // `useUnreadCount` polling loop. Subscribers (this process and
    // every other api replica) wake any locally-connected sockets;
    // the browser invalidates `notificationKeys.all` in react-query
    // and refetches via the existing REST endpoints.
    //
    // The `user` argument is whatever the caller emitted —
    // `Notification.upsertByActivity` and `Notification.read` pass an
    // ObjectId / UserDocument, depending on the call site — so we
    // normalise to a string id here before building the channel name.
    if (!user) return;
    const userId = userIdOf(user);
    if (!userId) return;
    publishNotificationsChange(crowi, userId);
  });

  const Notification = model<NotificationDocument, NotificationModel>('Notification', notificationSchema);

  // 静的プロパティをスキーマではなくモデルに直接割り当て
  Notification.STATUS_UNOPENED = STATUS_UNOPENED;
  Notification.STATUS_UNREAD = STATUS_UNREAD;
  Notification.STATUS_OPENED = STATUS_OPENED;

  return Notification;
};

/**
 * Normalise the `user` argument that `notificationEvent.emit('update', ...)`
 * receives into a string id. Different call sites historically passed
 * different shapes — an ObjectId, a UserDocument, or a populated user
 * subdocument — so we accept whichever and pick the canonical id.
 * Returns `null` if no usable id can be derived (defensive: never crash
 * the model on a malformed emit).
 */
function userIdOf(user: unknown): string | null {
  if (!user) return null;
  if (typeof user === 'string') return user;
  if (user instanceof Types.ObjectId) return user.toString();
  if (typeof user === 'object' && '_id' in user) {
    const id = (user as { _id: unknown })._id;
    if (typeof id === 'string') return id;
    if (id instanceof Types.ObjectId) return id.toString();
  }
  return null;
}

/**
 * Publish a `{type:'changed'}` invalidation tick on the user's
 * notifications channel. No-op when `crowi.redis` is null (degrade
 * mode: single-instance dev with `REDIS_URL` unset). Failures are
 * warn-only — the polling-removed UI degrades gracefully (the next
 * user action triggers a react-query refetch).
 *
 * The publish is fire-and-forget on purpose: the model statics that
 * invoke `notificationEvent.emit('update', ...)` are awaited by their
 * REST handlers, and we do not want a transient Redis publish failure
 * to surface as a 500 on the user's write request — the notification
 * itself succeeded.
 */
function publishNotificationsChange(crowi: Crowi, userId: string): void {
  const redis = crowi.redis as { publish?: (channel: string, message: string) => Promise<number> } | null | undefined;
  if (!redis || typeof redis.publish !== 'function') return;
  const channel = `${NOTIFICATIONS_CHANNEL_PREFIX}${userId}`;
  const message = JSON.stringify({ type: 'changed' });
  Promise.resolve()
    .then(() => redis.publish!(channel, message))
    .catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[crowi:notifications] publish failed for user ${userId}: ${m}`);
    });
}

/**
 * RFC-0002 Phase 8: forward an upserted notification to every active
 * notifier plugin (Slack / Webhook / ...). Driver `send()` is called
 * with a normalised `NotificationPayload`; each call is wrapped so a
 * single failing driver does not break the others.
 *
 * The plugin manager is bootstrapped during `Crowi.init()` and may be
 * absent on early-test code paths — we silently no-op then. Reading
 * `crowi.getPlugins()` would throw in that state; the optional access
 * pattern below keeps both the test and production paths simple.
 */
function forwardToNotifierPlugins(crowi: Crowi, notification: NotificationDocument, activity: ActivityDocument): void {
  const registries = (crowi as Crowi & { pluginRegistries?: { active: { notifiers: { send(p: NotificationPayload): Promise<void> }[] } } }).pluginRegistries;
  const notifiers = registries?.active?.notifiers ?? [];
  if (notifiers.length === 0) return;

  const payload: NotificationPayload = {
    title: `[${activity.action}] page=${String(notification.target)}`,
    body: `user=${String(notification.user)} activity=${String(activity._id)}`,
    event: `notification:${activity.action}`,
  };

  for (const driver of notifiers) {
    Promise.resolve()
      .then(() => driver.send(payload))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[crowi:notification] notifier driver send failed: ${message}`);
      });
  }
}
