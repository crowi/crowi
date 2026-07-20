import crypto from 'crypto';
import Debug from 'debug';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';
import FileUploader from 'src/util/fileUploader';
import {
  type AttachmentDerivatives,
  type AttachmentDisplayDerivative,
  DISPLAY_DERIVATIVE_MIME_TYPES,
  DISPLAY_DERIVATIVE_MODES,
  DISPLAY_DERIVATIVE_REASONS,
  DISPLAY_DERIVATIVE_RECIPE_VERSION,
  displayDerivativeKeyCandidates,
} from 'src/util/image-display-derivative';

export type { AttachmentDerivatives, AttachmentDisplayDerivative };

export interface AttachmentDocument extends Document {
  _id: Types.ObjectId;
  page: Types.ObjectId;
  creator: Types.ObjectId;
  filePath: string;
  fileName: string;
  originalName: string;
  fileFormat: string;
  fileSize: number;
  createdAt: Date;
  /**
   * feature-image-derivative-optimization Phase 1 — best-effort display
   * derivatives (currently just `display`). Absent entirely on
   * legacy/not-yet-evaluated attachments — treat that as a 5th state
   * distinct from every `mode`, and fall back to `filePath` (original).
   * Never `required` — additive, backward-compatible with existing rows.
   */
  derivatives?: AttachmentDerivatives;

  // virtual
  fileUrl: string;

  // dynamic field
  url: string;
}

export interface AttachmentModel extends Model<AttachmentDocument> {
  getListByPageId(id: Types.ObjectId): Promise<AttachmentDocument[]>;
  guessExtByFileType(fileType: string): string;
  createAttachmentFilePath(pageId: Types.ObjectId, fileName: string, fileType: string): string;
  removeAttachmentsByPageId(pageId: Types.ObjectId): any;
  findDeliveryFile(attachment: AttachmentDocument, forceUpdate?: boolean): any;
  removeAttachment(attachment: AttachmentDocument): any;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:attachment');
  const fileUploader = FileUploader(crowi);

  function generateFileHash(fileName) {
    const hasher = crypto.createHash('md5');
    hasher.update(fileName);

    return hasher.digest('hex');
  }

  // feature-image-derivative-optimization Phase 1 — every enum here is
  // sourced from `image-display-derivative.ts` (the generator's own
  // classification tables), not hand-duplicated, so the storage layer
  // rejects anything the generator could never actually produce (a typo'd
  // `reason`, a `format` that isn't one of the 3 fixed MIME strings, a
  // `recipeVersion` other than the current literal) instead of silently
  // accepting an arbitrary Number/String.
  const attachmentDisplayDerivativeSchema = new Schema<AttachmentDisplayDerivative>(
    {
      recipeVersion: { type: Number, required: true, enum: [DISPLAY_DERIVATIVE_RECIPE_VERSION] },
      mode: { type: String, required: true, enum: DISPLAY_DERIVATIVE_MODES },
      reason: { type: String, enum: DISPLAY_DERIVATIVE_REASONS },
      // Only set when mode === 'resized' — the derivative object's storage key.
      filePath: { type: String },
      // MIME type string (e.g. `image/jpeg`), NOT a sharp decoder identifier — see image-display-derivative.ts.
      format: { type: String, enum: DISPLAY_DERIVATIVE_MIME_TYPES },
      width: { type: Number },
      height: { type: Number },
      size: { type: Number },
      generatedAt: { type: Date, required: true },
    },
    { _id: false },
  );

  const attachmentDerivativesSchema = new Schema<AttachmentDerivatives>(
    {
      display: { type: attachmentDisplayDerivativeSchema, default: undefined },
    },
    { _id: false },
  );

  const attachmentSchema = new Schema<AttachmentDocument, AttachmentModel>(
    {
      page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
      creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      filePath: { type: String, required: true },
      fileName: { type: String, required: true },
      originalName: { type: String },
      fileFormat: { type: String, required: true },
      fileSize: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now },
      derivatives: { type: attachmentDerivativesSchema, default: undefined },
    },
    {
      toJSON: {
        virtuals: true,
      },
    },
  );

  attachmentSchema.virtual('fileUrl').get(function (this: AttachmentDocument) {
    // Streamed via the ts-rest router at `packages/api/src/routes/ts-rest/attachment.ts`.
    // The legacy `/files/:id` route now 302-redirects here for back-compat
    // with body URLs persisted before the migration.
    return `/api/v2/attachments/${this._id}`;
  });

  attachmentSchema.statics.getListByPageId = function (id) {
    return Attachment.find({ page: id }).sort({ updatedAt: 1 }).populate('creator').exec();
  };

  attachmentSchema.statics.guessExtByFileType = function (fileType) {
    let ext = '';
    const isImage = fileType.match(/^image\/(.+)/i);

    if (isImage) {
      ext = isImage[1].toLowerCase();
    }

    return ext;
  };

  attachmentSchema.statics.createAttachmentFilePath = function (pageId, fileName, fileType) {
    let ext = '';
    const fnExt = fileName.match(/(.*)(?:\.([^.]+$))/);

    if (fnExt) {
      ext = '.' + fnExt[2];
    } else {
      ext = Attachment.guessExtByFileType(fileType);
      if (ext !== '') {
        ext = '.' + ext;
      }
    }

    return 'attachment/' + pageId + '/' + generateFileHash(fileName) + ext;
  };

  attachmentSchema.statics.removeAttachmentsByPageId = async function (pageId) {
    const attachments = await Attachment.getListByPageId(pageId);
    await Promise.all(attachments.map((attachment) => Attachment.removeAttachment(attachment)));

    return attachments;
  };

  attachmentSchema.statics.findDeliveryFile = function (attachment, forceUpdate) {
    // TODO
    forceUpdate = forceUpdate || false;

    return fileUploader.findDeliveryFile(attachment._id, attachment.filePath);
  };

  // feature-image-derivative-optimization spec §10 — `findOneAndDelete`
  // makes the row-delete and the "final snapshot" read a single atomic
  // Mongo operation, so a `derivatives.display` published by a concurrent
  // generator moments before this call is reliably captured (unlike
  // trusting the caller-supplied `attachment` argument, which may have
  // been read before that publish). Row delete stays FIRST and original
  // delete failure still surfaces as a thrown error afterwards — the
  // `DELETE /api/v2/attachments/:id` contract (500 on original-delete
  // failure) is unchanged.
  attachmentSchema.statics.removeAttachment = async function (attachment) {
    const deleted = (await Attachment.findOneAndDelete({ _id: attachment._id })) as AttachmentDocument | null;
    if (!deleted) {
      // Already removed by a concurrent call (or never existed) — idempotent no-op.
      return;
    }

    let originalDeleteError: unknown;
    try {
      await fileUploader.deleteFile(deleted._id, deleted.filePath);
    } catch (err) {
      originalDeleteError = err;
    }

    // Always attempt derivative cleanup, regardless of whether the original
    // delete above succeeded — union of (a) the publish-recorded display
    // key (if any) and (b) the deterministic v1 key candidates
    // (jpg/png/webp). (b) alone catches a "put succeeded, publish never
    // ran" orphan (spec §7 end / §10 case D), which (a) can't see because
    // `derivatives.display` was never set. `deleteFile` is idempotent, so
    // sweeping all candidates unconditionally is safe.
    const derivativeKeys = new Set<string>(displayDerivativeKeyCandidates(deleted.page, deleted._id));
    const publishedKey = deleted.derivatives?.display?.filePath;
    if (publishedKey) derivativeKeys.add(publishedKey);

    await Promise.all(
      [...derivativeKeys].map((key) =>
        fileUploader.deleteFile(deleted._id, key).catch((err) => {
          debug('best-effort derivative delete failed during removeAttachment for %s: %s', key, err instanceof Error ? err.message : String(err));
        }),
      ),
    );

    if (originalDeleteError) throw originalDeleteError;
  };

  const Attachment = model<AttachmentDocument, AttachmentModel>('Attachment', attachmentSchema);

  return Attachment;
};
