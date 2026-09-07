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
} from './page-user-relation';

// Named alias for `RelationDocument` — every `Seen`-specific static below is typed against this name, not the shared one.
export type SeenDocument = RelationDocument;

export interface SeenModel extends Model<SeenDocument> {
  add(pageId: Types.ObjectId, userId: Types.ObjectId): Promise<RelationAddResult<SeenDocument>>;
  getCountsByPageIds(pageIds: (string | Types.ObjectId)[], options?: RelationReadOptions): Promise<Map<string, number>>;
  findByPageId(pageId: Types.ObjectId, options?: RelationReadOptions): Promise<SeenDocument[]>;
  removeByPageId(pageId: Types.ObjectId): Promise<void>;
  ensureUniqueIndex(): Promise<void>;
}

export default (crowi: Crowi) => {
  // Same index shape / `autoIndex: false` rationale as `Like` (D-1) — see
  // that model's schema comment. `Seen` has no single-row `remove`: the
  // only deletion path is the whole-page `removeByPageId` cleanup static
  // (post-delete cleanup, D-6's delete/insert race compensation).
  const SeenSchema = new Schema<SeenDocument, SeenModel>(
    {
      page: { type: Schema.Types.ObjectId, ref: 'Page', index: true, required: true },
      user: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
      createdAt: { type: Date, default: null },
    },
    { autoIndex: false },
  );
  SeenSchema.index({ page: 1, user: 1 }, { unique: true });

  SeenSchema.statics.add = async function (pageId, userId) {
    return addRelationRow(Seen, pageId, userId);
  };

  SeenSchema.statics.getCountsByPageIds = async function (pageIds, options) {
    return getRelationCountsByPageIds(Seen, pageIds, options);
  };

  // D-1: unbounded fetch, `_id` ascending — a deterministic (not legacy-
  // array-order-preserving) default sort so `limit` slicing downstream is
  // reproducible. No `limit` option here by design (spec D-1): the count
  // must come from this same unbounded array's length, never a separate
  // capped query.
  SeenSchema.statics.findByPageId = async function (pageId, options) {
    return applyReadPreference(Seen.find({ page: pageId }).sort({ _id: 1 }), options).exec();
  };

  SeenSchema.statics.removeByPageId = async function (pageId) {
    await Seen.deleteMany({ page: pageId }).exec();
  };

  SeenSchema.statics.ensureUniqueIndex = async function (): Promise<void> {
    return assertRelationUniqueIndex(Seen, 'Seen');
  };

  const Seen = model<SeenDocument, SeenModel>('Seen', SeenSchema);

  return Seen;
};
