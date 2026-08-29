import { Document, Model, Schema, Types, model } from 'mongoose';

import type Crowi from 'src/crowi';

export const PAGE_DELETION_MODES = ['user_hard_delete'] as const;

export interface PageDeletionRecordDocument extends Document {
  _id: Types.ObjectId;
  pageId: Types.ObjectId;
  path: string;
  actor: Types.ObjectId | null;
  deletedAt: Date;
  mode: (typeof PAGE_DELETION_MODES)[number];
}

// biome-ignore lint/suspicious/noEmptyInterface: deletion-record queries use the base Mongoose Model API.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PageDeletionRecordModel extends Model<PageDeletionRecordDocument> {}

const pageDeletionRecordSchema = new Schema<PageDeletionRecordDocument, PageDeletionRecordModel>(
  {
    // This is evidence about a row that no longer exists, not a relation to
    // populate. Keeping it ref-free also prevents path reuse from binding the
    // record to a later Page.
    pageId: { type: Schema.Types.ObjectId, required: true },
    path: { type: String, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date, required: true },
    mode: { type: String, enum: PAGE_DELETION_MODES, required: true },
  },
  { strict: 'throw', versionKey: false },
);

pageDeletionRecordSchema.index({ path: 1, deletedAt: -1 }, { name: 'pageDeletionRecord_path_deletedAt' });
pageDeletionRecordSchema.index({ deletedAt: -1 }, { name: 'pageDeletionRecord_deletedAt' });
pageDeletionRecordSchema.index({ pageId: 1 }, { name: 'pageDeletionRecord_pageId' });

export default (_crowi: Crowi) => model<PageDeletionRecordDocument, PageDeletionRecordModel>('PageDeletionRecord', pageDeletionRecordSchema);
