import Crowi from 'src/crowi';
import { Types, Document, Model, Schema, model } from 'mongoose';
import Debug from 'debug';
import ActivityDefine from 'src/util/activityDefine';

export interface ActivityDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId | any;
  targetModel: string;
  target: string;
  action: string;
  event: Types.ObjectId;
  eventModel: string;
  createdAt: Date;

  getNotificationTargetUsers(): Promise<any[]>;
}

export interface ActivityModel extends Model<ActivityDocument> {
  createByParameters(parameters: any): Promise<ActivityDocument>;
  removeByParameters(parameters: any): any;
  createByPageComment(comment: any): Promise<ActivityDocument>;
  removeByPageCommentDelete(comment: any): Promise<{ deletedCount: number }>;
  createByPageLike(page: any, user: any): Promise<ActivityDocument>;
  removeByPageUnlike(page: any, user: any): Promise<{ deletedCount: number }>;
  createByPageUpdate(page: any, user: any): Promise<ActivityDocument>;
  createByPageMention(page: any, mentionedUser: any, author: any): Promise<ActivityDocument>;
  removeByPage(page: any): Promise<{ deletedCount: number }>;
  findByUser(user: any): Promise<ActivityDocument[]>;
  getActionUsersFromActivities(activities: ActivityDocument[]): any[];
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:activity');
  const activityEvent = crowi.event('Activity');

  // TODO: add revision id
  const activitySchema = new Schema<ActivityDocument, ActivityModel>({
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
  });
  activitySchema.index({ target: 1, action: 1 });
  activitySchema.index({ user: 1, target: 1, action: 1, createdAt: 1 }, { unique: true });

  /**
   * @param {object} parameters
   * @return {Promise}
   */
  activitySchema.statics.createByParameters = function (parameters) {
    return Activity.create(parameters);
  };

  /**
   * @param {object} parameters
   */
  activitySchema.statics.removeByParameters = async function (parameters) {
    const activity = await Activity.findOne(parameters);
    activityEvent.emit('remove', activity);

    return Activity.deleteMany(parameters).exec();
  };

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
    };

    return this.createByParameters(parameters);
  };

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
    };

    return this.removeByParameters(parameters);
  };

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
    };

    return this.createByParameters(parameters);
  };

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
    };

    return this.removeByParameters(parameters);
  };

  /**
   * feature-page-update-notification: record a page body update (a new
   * revision was created). Fanned out to every page watcher by the
   * `Activity.post('save')` hook below — the same path COMMENT / LIKE
   * use — so the editor (excluded as `actionUser`) does not get notified
   * of their own save.
   *
   * @param {Page} page page document whose body was updated
   * @param {User} user user who authored the new revision
   * @return {Promise<ActivityDocument>}
   */
  activitySchema.statics.createByPageUpdate = function (page, user) {
    const parameters = {
      user: user._id,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page._id,
      action: ActivityDefine.ACTION_UPDATE,
    };

    return this.createByParameters(parameters);
  };

  /**
   * RFC-0002 Phase 8: record a `@username` mention on a page save.
   *
   * Unlike comment / like, MENTION is dispatched per mentioned-user from
   * `events/mention-dispatch.ts` — the `Activity.post('save')` watcher
   * fan-out path is intentionally skipped (see hook below) because a
   * mention has a single intended recipient.
   *
   * @param {Page} page page document being mentioned in
   * @param {User} mentionedUser user resolved from the `@username` token
   * @param {User} author user who authored the revision
   * @return {Promise<ActivityDocument>}
   */
  activitySchema.statics.createByPageMention = function (page, mentionedUser, author) {
    const parameters = {
      user: author._id,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page._id,
      action: ActivityDefine.ACTION_MENTION,
    };

    return this.createByParameters(parameters);
  };

  /**
   * @param {Page} page
   * @return {Promise}
   */
  activitySchema.statics.removeByPage = async function (page) {
    const activities = await Activity.find({ target: page });
    for (const activity of activities) {
      activityEvent.emit('remove', activity);
    }
    return Activity.deleteMany({ target: page }).exec();
  };

  /**
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.findByUser = function (user) {
    return Activity.find({ user: user }).sort({ createdAt: -1 }).exec();
  };

  activitySchema.statics.getActionUsersFromActivities = function (activities) {
    return activities.map(({ user }) => user).filter((user, i, self) => self.indexOf(user) === i);
  };

  /**
   * feature-watch-autosubscribe — watcher-only notification fan-out.
   *
   * The notification audience is now exactly the explicit WATCH watchers
   * minus the IGNORE opt-outs, minus the action user, minus inactive
   * users. The legacy implicit set (page creator + comment authors +
   * revision authors via `Page.getNotificationTargetUsers()`) is no
   * longer mixed in — participation now materialises a real WATCH row
   * via `autoWatchPage` (events/page.ts + comment handler), so the
   * watcher collection is the single source of truth for "who gets
   * notified". This makes `getWatchStatus` exact and lets anyone
   * plainly unwatch.
   */
  activitySchema.methods.getNotificationTargetUsers = async function () {
    const User = crowi.model('User');
    const Watcher = crowi.model('Watcher');
    const { user: actionUser, target } = this;

    const [watchUsers, ignoreUsers] = await Promise.all([
      Watcher.getWatchers(target as any as Types.ObjectId),
      Watcher.getIgnorers(target as any as Types.ObjectId),
    ]);

    const unique = (array) => Object.values(array.reduce((objects, object) => ({ ...objects, [object.toString()]: object }), {}));
    const filter = (array, pull) => {
      const ids = pull.map((object) => object.toString());
      return array.filter((object) => !ids.includes(object.toString()));
    };
    const notificationUsers = filter(unique(watchUsers), [...ignoreUsers, actionUser]);
    const activeNotificationUsers = await User.find({
      _id: { $in: notificationUsers },
      status: User.STATUS_ACTIVE,
    }).distinct('_id');
    return activeNotificationUsers;
  };

  /**
   * saved hook
   *
   * For COMMENT / LIKE we fan-out a notification to every page watcher
   * via `getNotificationTargetUsers()` (the legacy behaviour). For
   * MENTION the dispatcher in `events/mention-dispatch.ts` calls
   * `Notification.upsertByActivity` directly for the single mentioned
   * user, so we MUST skip the fan-out here — otherwise watchers would
   * receive spurious MENTION notifications they were not the target of.
   */
  activitySchema.post('save', (savedActivity: ActivityDocument) => {
    if (savedActivity.action === ActivityDefine.ACTION_MENTION) {
      return;
    }

    const Notification = crowi.model('Notification');

    savedActivity
      .getNotificationTargetUsers()
      .then((notificationUsers) => {
        return Promise.all(notificationUsers.map((user) => Notification.upsertByActivity(user, savedActivity)));
      })
      .catch((err) => {
        debug(err);
      });
  });

  // because mongoose's 'remove' hook fired only when remove by a method of Document (not by a Model method)
  // move 'save' hook from mongoose's events to activityEvent if I have a time.
  activityEvent.on('remove', async function (activity: ActivityDocument) {
    const Notification = crowi.model('Notification');

    try {
      await Notification.removeActivity(activity);
    } catch (err) {
      debug(err);
    }
  });

  const Activity = model<ActivityDocument, ActivityModel>('Activity', activitySchema);

  return Activity;
};
