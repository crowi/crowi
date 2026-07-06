import Debug from 'debug';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';

export interface CommentDocument extends Document {
  _id: Types.ObjectId;
  page: Types.ObjectId | any;
  creator: Types.ObjectId;
  revision: Types.ObjectId;
  comment: string;
  commentPosition: number;
  createdAt: Date;
}
export interface CommentModel extends Model<CommentDocument> {
  getCommentsByPageId(id: Types.ObjectId): Promise<CommentDocument[]>;
  getCommentsByRevisionId(id: Types.ObjectId): Promise<CommentDocument[]>;
  countCommentByPageId(page: any): Promise<number>;
  removeCommentsByPageId(pageId: Types.ObjectId): Promise<void>;
  removeCommentById(id: Types.ObjectId): Promise<void>;
  findCreatorsByPage(page: any): Promise<any[]>;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:comment');

  const commentSchema = new Schema<CommentDocument, CommentModel>({
    page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
    creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    revision: { type: Schema.Types.ObjectId, ref: 'Revision', index: true },
    comment: { type: String, required: true },
    commentPosition: { type: Number, default: -1 },
    createdAt: { type: Date, default: Date.now },
  });

  commentSchema.statics.getCommentsByPageId = function (id) {
    return Comment.find({ page: id }).sort({ createdAt: -1 }).populate('creator').exec();
  };

  commentSchema.statics.getCommentsByRevisionId = function (id) {
    return Comment.find({ revision: id }).sort({ createdAt: -1 }).populate('creator').exec();
  };

  commentSchema.statics.countCommentByPageId = function (page) {
    return Comment.countDocuments({ page }).exec();
  };

  commentSchema.statics.removeCommentsByPageId = async function (pageId) {
    await Comment.deleteMany({ page: pageId }).exec();
  };

  commentSchema.statics.removeCommentById = async function (id) {
    const comment = await Comment.findOne({ _id: id }).exec();
    await Comment.deleteOne({ _id: id }).exec();
    // Emit AFTER the row is durably deleted: the presence-broadcast
    // listener tells viewers to re-fetch `GET /comments`, and a pre-delete
    // emit could race that re-fetch (the viewer would still read the
    // not-yet-deleted comment and get no later frame to correct it). Skip
    // when the row was already gone (nothing to broadcast / clean up).
    if (comment) commentEvent.emit('remove', comment);
  };

  commentSchema.statics.findCreatorsByPage = function (page) {
    return Comment.distinct('creator', { page }).exec();
  };

  // Capture creation-vs-update before mongoose flips `isNew` to false in
  // the post-save hook, so the live-sync 'add' emit below fires ONLY for a
  // genuinely new comment. Comments are create-only today, but an
  // unconditional emit would broadcast a false `comment-changed: added` if
  // any future path re-saved an existing comment.
  commentSchema.pre('save', function (this: CommentDocument) {
    this.$locals.wasNew = this.isNew;
  });

  /**
   * post save hook
   */
  commentSchema.post('save', function (savedComment: CommentDocument) {
    const Page = crowi.model('Page');
    const Activity = crowi.model('Activity');

    crowi.trackSideEffect(
      Promise.resolve()
        .then(function () {
          // Skip the deferred commentCount recompute once the connection
          // is no longer `connected` — it would only throw teardown-noise.
          // Normal operation (readyState === 1) is unaffected.
          if (!crowi.isMongoConnected()) return;
          return Comment.countCommentByPageId(savedComment.page).then(function (count) {
            return Page.updateCommentCount(savedComment.page, count);
          });
        })
        .then(function (page) {
          debug('CommentCount Updated', page);
        })
        .catch(function (err) {
          debug('Failed to update commentCount', err);
        }),
    );

    crowi.trackSideEffect(
      Promise.resolve()
        .then(function () {
          if (!crowi.isMongoConnected()) return;
          return Activity.createByPageComment(savedComment);
        })
        .then(function (activityLog) {
          debug('Activity created', activityLog);
        })
        .catch(function (err) {
          debug('Failed to create comment Activity', err);
        }),
    );

    // feature-live-page-comment-sync — emit an 'add' event symmetric to
    // `removeCommentById`'s 'remove', but ONLY on creation (see the
    // pre-save hook above). The presence-broadcast listener fans this out
    // over the /presence channel so viewers see the new comment without a
    // reload. Best-effort: a listener throw must never break the save, so
    // the listener wraps its own async work.
    if (savedComment.$locals.wasNew === true) {
      commentEvent.emit('add', savedComment);
    }
  });

  const commentEvent = crowi.event('Comment');
  commentEvent.on('remove', async function (comment: CommentDocument) {
    const Activity = crowi.model('Activity');

    try {
      await Activity.removeByPageCommentDelete(comment);
    } catch (err) {
      debug(err);
    }
  });

  const Comment = model<CommentDocument, CommentModel>('Comment', commentSchema);

  return Comment;
};
