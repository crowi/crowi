import Crowi from 'src/crowi';
import { Types, Model, Schema, model } from 'mongoose';
import {
  type RelationAddResult,
  type RelationDocument,
  type RelationReadOptions,
  addRelationRow,
  applyReadPreference,
  assertRelationUniqueIndex,
  getRelationCountsByPageIds,
  toObjectId,
} from './page-user-relation';

// Named alias for `RelationDocument` — every `Like`-specific static below is typed against this name, not the shared one.
export type LikeDocument = RelationDocument;

export interface LikeModel extends Model<LikeDocument> {
  add(pageId: Types.ObjectId, userId: Types.ObjectId): Promise<RelationAddResult<LikeDocument>>;
  remove(pageId: Types.ObjectId, userId: Types.ObjectId): Promise<{ removed: boolean }>;
  countByPageId(pageId: Types.ObjectId, options?: RelationReadOptions): Promise<number>;
  getCountsByPageIds(pageIds: (string | Types.ObjectId)[], options?: RelationReadOptions): Promise<Map<string, number>>;
  getLikedPageIdsByUser(pageIds: (string | Types.ObjectId)[], userId: Types.ObjectId, options?: RelationReadOptions): Promise<Set<string>>;
  existsByPageAndUser(pageId: Types.ObjectId, userId: Types.ObjectId, options?: RelationReadOptions): Promise<boolean>;
  countByUserId(userId: Types.ObjectId): Promise<number>;
  findByPageId(pageId: Types.ObjectId): Promise<LikeDocument[]>;
  removeByPageId(pageId: Types.ObjectId): Promise<void>;
  ensureUniqueIndex(): Promise<void>;
}

export default (crowi: Crowi) => {
  // D-1: `Bookmark`'s index shape (page / user single indexes + a
  // {page,user} compound unique) reused verbatim, but `autoIndex: false` —
  // building these 3 indexes is deferred to `ensureUniqueIndex()`, called
  // only from the `feature-page-relations-cutover` boot step / migration
  // stage. Registering this model must never fire an implicit index build
  // (that would race the cutover migration that has to run first).
  const LikeSchema = new Schema<LikeDocument, LikeModel>(
    {
      page: { type: Schema.Types.ObjectId, ref: 'Page', index: true, required: true },
      user: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
      // Default null (not Date.now): a live `add()` sets the real timestamp
      // itself via `$setOnInsert`, so a bulk migration copy that writes rows
      // without an explicit createdAt does not silently backdate them to the
      // migration's run time (spec D-1).
      createdAt: { type: Date, default: null },
    },
    { autoIndex: false },
  );
  LikeSchema.index({ page: 1, user: 1 }, { unique: true });

  LikeSchema.statics.add = async function (pageId, userId) {
    return addRelationRow(Like, pageId, userId);
  };

  LikeSchema.statics.remove = async function (pageId, userId) {
    const result = await Like.deleteOne({ page: pageId, user: userId }).exec();
    return { removed: (result.deletedCount ?? 0) > 0 };
  };

  LikeSchema.statics.countByPageId = async function (pageId, options) {
    return applyReadPreference(Like.countDocuments({ page: pageId }), options).exec();
  };

  LikeSchema.statics.getCountsByPageIds = async function (pageIds, options) {
    return getRelationCountsByPageIds(Like, pageIds, options);
  };

  LikeSchema.statics.getLikedPageIdsByUser = async function (pageIds, userId, options) {
    if (pageIds.length === 0) return new Set();
    const ids = pageIds.map(toObjectId);
    const rows = await applyReadPreference(Like.find({ page: { $in: ids }, user: userId }).select('page'), options).exec();
    return new Set(rows.map((row) => row.page.toString()));
  };

  LikeSchema.statics.existsByPageAndUser = async function (pageId, userId, options) {
    const found = await applyReadPreference(Like.exists({ page: pageId, user: userId }), options);
    return found != null;
  };

  // D-6: profile `likesCount` must not count rows whose Page was already
  // physically deleted (a `Like` cleanup failure orphan) — the `$lookup`
  // existence filter is what makes that guarantee, not merely counting
  // `likes.user` rows.
  LikeSchema.statics.countByUserId = async function (userId) {
    const result = await Like.aggregate<{ count: number }>([
      { $match: { user: userId } },
      { $lookup: { from: 'pages', localField: 'page', foreignField: '_id', as: 'existingPage' } },
      { $match: { existingPage: { $ne: [] } } },
      { $count: 'count' },
    ]);
    return result[0]?.count ?? 0;
  };

  // D-1/F-3: unbounded, unordered fetch of every Like row for a page — the
  // presence handler owns the Activity-fallback join, stable ordering, and
  // `limit` slicing. No server-side cap here (spec C-PERF accepts this at
  // crowi's operating scale).
  LikeSchema.statics.findByPageId = async function (pageId) {
    return Like.find({ page: pageId }).exec();
  };

  LikeSchema.statics.removeByPageId = async function (pageId) {
    await Like.deleteMany({ page: pageId }).exec();
  };

  LikeSchema.statics.ensureUniqueIndex = async function (): Promise<void> {
    return assertRelationUniqueIndex(Like, 'Like');
  };

  const Like = model<LikeDocument, LikeModel>('Like', LikeSchema);

  return Like;
};
