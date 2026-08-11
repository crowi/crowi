import Debug from 'debug';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';
import { STATUS_DELETED } from './page';

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

/**
 * RFC-0021 §7.1 (`feature-page-history-phase1-model`, Phase 1) — the
 * Page state `addComment` (`hono/handlers/comment.ts`) captured at
 * authorization time, stashed on `$locals.authSnapshot` before the insert
 * so the post-insert lifecycle re-validation hook below can compare
 * against it. See that hook's doc comment for the full contract.
 */
export interface CommentAuthSnapshot {
  status: unknown;
  path: string;
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

  /**
   * `page` may be a bare ObjectId or a populated Page document, depending on
   * what the caller set (`Comment.create({ page, ... })` accepts either, and
   * a bare `String()` on a document collapses to `'[object Object]'`
   * instead of the id). Resolves to the underlying id either way. Shared by
   * {@link recalculateCommentCount} and the post-insert lifecycle
   * re-validation hook below — both need the same resolution.
   */
  function resolvePageRefId(page: unknown): unknown {
    return (page as { _id?: unknown })?._id ?? page;
  }

  /**
   * Tail of the in-flight recalc chain per page id. See
   * {@link recalculateCommentCount} for why serialisation is required.
   */
  const recalcTails = new Map<string, Promise<unknown>>();

  /**
   * Recompute Page.commentCount from the live Comment collection. Shared by
   * the post('save') hook (comment created) and the 'remove' event listener
   * (comment deleted) so both paths keep the count in sync the same way
   * (QA-5-01: deletion used to leave the count stale until the next create).
   *
   * Recalcs for the SAME page are serialised through a promise chain,
   * because count-then-write is not atomic: two chains racing on one page
   * can interleave as read(1) / read(2) / write(2) / write(1), leaving the
   * stale 1 as the final value until the next create or delete. That is a
   * real production lost update (concurrent comment posts on one page), not
   * just the test flake it was first noticed as — `drainSideEffects()`
   * waits for both chains to settle but cannot impose an order.
   *
   * Serialising is sound because each chain is enqueued AFTER its own
   * mutation has committed: whichever recalc runs last therefore counts a
   * collection that already includes every mutation enqueued before it, so
   * the final write is always the true value. A full recount (rather than
   * `$inc`) is kept deliberately — it self-heals if an event is ever missed,
   * which is the drift QA-5-01 originally fixed.
   *
   * Process-local only. Two api replicas can still interleave; a shared lock
   * would be disproportionate for a display counter that the next
   * create/delete corrects anyway.
   */
  function recalculateCommentCount(pageId: CommentDocument['page']) {
    const Page = crowi.model('Page');
    const key = String(resolvePageRefId(pageId));
    const previous = recalcTails.get(key) ?? Promise.resolve();

    // `.catch` sits at the tail, so `previous` is always fulfilled and one
    // failed recalc can never stall the chain for that page.
    const run = previous
      .then(function () {
        // Skip the deferred commentCount recompute once the connection
        // is no longer `connected` — it would only throw teardown-noise.
        // Normal operation (readyState === 1) is unaffected.
        if (!crowi.isMongoConnected()) return;
        return Comment.countCommentByPageId(pageId).then(function (count) {
          return Page.updateCommentCount(pageId, count);
        });
      })
      .then(function (page) {
        debug('CommentCount Updated', page);
      })
      .catch(function (err) {
        debug('Failed to update commentCount', err);
      })
      .finally(function () {
        // Drop the entry only while still the tail, so the map cannot grow
        // without bound but a queued successor is never orphaned.
        if (recalcTails.get(key) === run) recalcTails.delete(key);
      });

    recalcTails.set(key, run);
    crowi.trackSideEffect(run);
  }

  // Capture creation-vs-update before mongoose flips `isNew` to false in
  // the post-save hook, so the live-sync 'add' emit below fires ONLY for a
  // genuinely new comment. Comments are create-only today, but an
  // unconditional emit would broadcast a false `comment-changed: added` if
  // any future path re-saved an existing comment.
  commentSchema.pre('save', function (this: CommentDocument) {
    this.$locals.wasNew = this.isNew;
  });

  /**
   * RFC-0021 §7.1 (`feature-page-history-phase1-model`, Phase 1) —
   * post-insert lifecycle re-validation. `addComment`
   * (`hono/handlers/comment.ts`) authorizes the Page and THEN inserts the
   * Comment — two separate operations. If the Page is trashed OR renamed in
   * between, the insert still succeeds (a Comment is keyed by the Page's
   * immutable `_id`, and trash is mechanically `Page.rename` + `status:
   * STATUS_DELETED` on that SAME document — see `Page.deletePage`), leaving
   * a comment that no longer matches what its author was actually
   * authorized against. This is one of the two mechanisms RFC §7.1 requires
   * together (the other is the delete-side sweep, out of scope until Phase
   * 4's hard-delete state machine) — a comment created in that window is
   * compensated here by the writer that created it.
   *
   * Registered BEFORE the commentCount/Activity/live-sync post('save') hook
   * below so that when this hook throws, mongoose skips every later
   * post('save') hook for the same save — the count recalc and the
   * live-sync 'add' emit never fire for a comment this hook is about to
   * delete.
   *
   * Creation-only (`$locals.wasNew`, captured by the `pre('save')` hook
   * above): a later edit of an already-live comment must not be
   * compensated by this check — only the authorize-then-insert race RFC
   * §7.1 targets is in scope.
   *
   * `$locals.authSnapshot` (see {@link CommentAuthSnapshot}) is set by
   * `addComment` right after it authorizes the Page, BEFORE the insert —
   * `{status, path}` at that exact moment. This hook re-reads the Page
   * fresh and compares: EITHER field differing from the snapshot means
   * "what actually got authorized no longer matches the Page this comment
   * points at" — trash (status differs) and a plain rename (path differs,
   * even though a Comment is page-id-keyed and would otherwise stay
   * perfectly valid) are both covered, matching AC-10's literal "trash /
   * rename されていた場合" wording. Deliberately NOT covered: a trash-then-
   * restore round trip that lands back on the IDENTICAL {status, path} the
   * caller authorized. Detecting that would need a lifecycle-only
   * monotonic epoch on Page, which this spec's implementation map does not
   * add — `collabLifecycleVersion` (the one epoch Page already has) is
   * disqualified because `Page.updatePage` also advances it on every
   * ordinary content save, so gating on it would compensate comments
   * during normal concurrent editing, violating AC-10's "認可時と食い違わない
   * 通常経路の挙動は変わらない" clause. A round trip back to the exact state the
   * comment was authorized against is, by construction, not an
   * inconsistency to undo — the comment is attached to a Page whose current
   * state is exactly what its author saw.
   *
   * When `$locals.authSnapshot` is absent (a direct model caller — existing
   * tests, or any future writer that doesn't pass one), this hook falls
   * back to the narrower "the Page is gone or trashed" check Phase 1
   * originally shipped with, so it stays usable without the handler's
   * involvement.
   */
  commentSchema.post('save', async function (savedComment: CommentDocument) {
    if (savedComment.$locals.wasNew !== true) {
      return;
    }

    const Page = crowi.model('Page');
    const page = await Page.findById(resolvePageRefId(savedComment.page)).select('status path').lean().exec();
    const authSnapshot = savedComment.$locals.authSnapshot as CommentAuthSnapshot | undefined;

    const needsCompensation =
      page == null || (authSnapshot != null ? page.status !== authSnapshot.status || page.path !== authSnapshot.path : page.status === STATUS_DELETED);

    if (needsCompensation) {
      await Comment.deleteOne({ _id: savedComment._id }).exec();
      throw new Error('Page not found');
    }
  });

  /**
   * post save hook
   */
  commentSchema.post('save', function (savedComment: CommentDocument) {
    const Activity = crowi.model('Activity');

    recalculateCommentCount(savedComment.page);

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
  commentEvent.on('remove', function (comment: CommentDocument) {
    const Activity = crowi.model('Activity');

    crowi.trackSideEffect(
      Promise.resolve()
        .then(function () {
          return Activity.removeByPageCommentDelete(comment);
        })
        .catch(function (err) {
          debug(err);
        }),
    );

    // QA-5-01 — recalculate Page.commentCount on delete too, via the same
    // machinery the post('save') hook uses on create.
    recalculateCommentCount(comment.page);
  });

  const Comment = model<CommentDocument, CommentModel>('Comment', commentSchema);

  return Comment;
};
