import Crowi from 'src/crowi';
import { Types, Document, Model, Schema, model } from 'mongoose';
import { extractToc, type RevisionMetaShape, type TocEntryResponse } from '@crowi/api-contract';
import { PageDocument } from './page';
// import Debug from 'debug'

export type RevisionTocEntry = TocEntryResponse;
// `RevisionMetaContent` carries derived metadata (TOC etc.) stored on
// the revision document. Distinct from api-contract's `RevisionMeta`,
// which is a lightweight list-entry shape (id/path/author/createdAt).
export type RevisionMetaContent = RevisionMetaShape;

export interface RevisionDocument extends Document {
  _id: Types.ObjectId;
  path: string;
  body: string;
  format: string;
  author: Types.ObjectId;
  createdAt: Date;
  meta?: RevisionMetaContent;
}

export interface RevisionModel extends Model<RevisionDocument> {
  findLatestRevision(path: string, cb: (err: Error, data: RevisionDocument | null) => void): void;
  findRevision(id: Types.ObjectId): Promise<RevisionDocument | null>;
  findRevisions(ids): Promise<RevisionDocument[]>;
  findRevisionIdList(path): Promise<RevisionDocument[]>;
  findRevisionList(path, options): Promise<RevisionDocument[]>;
  updateRevisionListByPath(path, updateData): Promise<RevisionDocument>;
  prepareRevision(pageData: PageDocument, body, user, options?): RevisionDocument;
  removeRevisionsByPath(path): Promise<{ deletedCount: number }>;
  updatePath(pathName): void;
  findAuthorsByPage(page): Promise<RevisionDocument['author'][]>;
}

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:models:revision')

  const revisionSchema = new Schema<RevisionDocument, RevisionModel>({
    path: { type: String, required: true, index: true },
    body: { type: String, required: true },
    format: { type: String, default: 'markdown' },
    author: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    // Older revisions without `meta` fall back to on-the-fly TOC
    // generation in pageToResponse.
    meta: {
      type: new Schema<RevisionMetaContent>(
        {
          toc: {
            type: [
              new Schema<RevisionTocEntry>(
                {
                  level: { type: Number, required: true },
                  text: { type: String, required: true },
                  anchorId: { type: String, required: true },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
  });

  revisionSchema.statics.findLatestRevision = function (path, cb) {
    this.findOne({ path })
      .sort({ createdAt: -1 })
      .exec(function (err, data) {
        cb(err, data);
      });
  };

  revisionSchema.statics.findRevision = function (id) {
    return Revision.findById(id).populate('author').exec();
  };

  revisionSchema.statics.findRevisions = async function (ids) {
    if (!Array.isArray(ids)) {
      throw new Error('The argument was not Array.');
    }

    return Revision.find({ _id: { $in: ids } })
      .sort({ createdAt: -1 })
      .populate('author')
      .exec();
  };

  revisionSchema.statics.findRevisionIdList = function (path) {
    return Revision.find({ path: path }).select('_id author createdAt').sort({ createdAt: -1 }).exec();
  };

  revisionSchema.statics.findRevisionList = function (path, options) {
    return Revision.find({ path: path }).sort({ createdAt: -1 }).populate('author').exec();
  };

  revisionSchema.statics.updateRevisionListByPath = function (path, updateData) {
    return Revision.updateMany({ path: path }, { $set: updateData }).exec();
  };

  revisionSchema.statics.prepareRevision = function (pageData, body, user, options) {
    if (!options) {
      options = {};
    }
    const format = options.format || 'markdown';

    if (!user._id) {
      throw new Error('Error: user should have _id');
    }

    const newRevision = new Revision();
    newRevision.path = pageData.path;
    newRevision.body = body;
    newRevision.format = format;
    newRevision.author = user._id;
    newRevision.createdAt = Date.now() as any as Date;
    newRevision.meta = { toc: extractToc(body || '') };

    return newRevision;
  };

  revisionSchema.statics.removeRevisionsByPath = function (path) {
    return Revision.deleteMany({ path }).exec();
  };

  revisionSchema.statics.updatePath = function (pathName) {};

  revisionSchema.statics.findAuthorsByPage = function (page) {
    return Revision.distinct('author', { path: page.path }).exec() as Promise<RevisionDocument['author'][]>;
  };

  const Revision = model<RevisionDocument, RevisionModel>('Revision', revisionSchema);

  return Revision;
};
