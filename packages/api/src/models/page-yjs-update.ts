import type Crowi from 'src/crowi';
import { type Document, type Model, Schema, type Types, model } from 'mongoose';

/**
 * Append-only log of high-frequency Yjs updates for a page.
 *
 * RFC-0003 Phase 4 will write one document per Yjs `onChange` event so
 * Hocuspocus can recover edits made between the periodic checkpoints
 * that compact into `Page.yjsState`. Compaction (Phase 4) batches the
 * latest N documents per `pageId`, encodes them into `Page.yjsState`,
 * then deletes the source rows. Anything left behind is swept by the
 * TTL index after 1 hour — a safety net against crashed Hocuspocus
 * instances that fail to checkpoint.
 *
 * Indexes:
 *   1. compound `(pageId, createdAt)` — drives "load all updates for a
 *      page newer than the last checkpoint" on Hocuspocus recovery.
 *   2. `createdAt` TTL (`expireAfterSeconds: 3600`) — MongoDB sweeps
 *      rows older than 1 hour. Compaction normally clears them sooner;
 *      the TTL only kicks in for orphaned updates whose owning page
 *      was deleted or whose Hocuspocus instance crashed before
 *      checkpointing.
 *
 * Phase 1 only introduces the schema. The append + compaction paths
 * land in Phase 4 once Hocuspocus is wired up.
 */
export interface PageYjsUpdateDocument extends Document {
  _id: Types.ObjectId;
  pageId: Types.ObjectId;
  payload: Buffer;
  createdAt: Date;
}

// biome-ignore lint/suspicious/noEmptyInterface: placeholder for future statics that Phase 4 will introduce
export interface PageYjsUpdateModel extends Model<PageYjsUpdateDocument> {}

export default (_crowi: Crowi) => {
  const PageYjsUpdateSchema = new Schema<PageYjsUpdateDocument, PageYjsUpdateModel>(
    {
      pageId: { type: Schema.Types.ObjectId, required: true, ref: 'Page' },
      // Binary Yjs update payload (`Y.encodeStateAsUpdate` or the
      // delta from `onChange`). Buffer (not Mixed) so the BSON driver
      // round-trips a typed binary blob rather than a generic sub-doc.
      // Named `payload` rather than `update` to avoid colliding with
      // Mongoose's `Document.prototype.update()` method in TS typings.
      // Subject to MongoDB's 16 MB BSON document cap — Yjs delta
      // sizes are typically well below that, but Phase 4's append
      // step should bail out if a single delta exceeds the limit.
      payload: { type: Buffer, required: true },
      createdAt: { type: Date, required: true, default: () => new Date() },
    },
    {
      // `createdAt` is declared explicitly above so the TTL index has
      // a stable anchor; Mongoose's automatic timestamps would also
      // add `updatedAt` which is meaningless for an append-only log.
      timestamps: false,
    },
  );

  // (1) Compound `(pageId, createdAt)` — supports the Phase 4 read
  // pattern "all updates for this page in chronological order since
  // the last checkpoint".
  PageYjsUpdateSchema.index({ pageId: 1, createdAt: 1 }, { name: 'pageYjsUpdate_pageId_createdAt' });

  // (2) TTL — MongoDB removes rows older than 1 hour. Compaction in
  // Phase 4 normally deletes rows before this fires; the TTL is a
  // safety net for orphaned updates after a Hocuspocus crash.
  PageYjsUpdateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600, name: 'pageYjsUpdate_ttl' });

  return model<PageYjsUpdateDocument, PageYjsUpdateModel>('PageYjsUpdate', PageYjsUpdateSchema);
};
