import { Types, Document, Model, Schema, Query, model } from 'mongoose'
// import Debug from 'debug'

export interface RevisionDocument extends Document {
  path: string
  body: string
  format: string
  author: Types.ObjectId
  createdAt: Date
}

export interface RevisionModel extends Model<RevisionDocument> {
  findLatestRevision(path: string, cb: (err: Error, data: RevisionDocument) => void): any
  findRevision(id: Types.ObjectId): Promise<RevisionDocument | null>
  findRevisions(ids): Promise<RevisionDocument[]>
  findRevisionIdList(path): Promise<RevisionDocument[]>
  findRevisionList(path, options): Promise<RevisionDocument[]>
  updateRevisionListByPath(path, updateData, options): RevisionDocument
  prepareRevision(pageData, body, user, options): RevisionDocument
  removeRevisionsByPath(path): Query<any>
  updatePath(pathName): void
  findAuthorsByPage(page): RevisionDocument['author'][]
}

export default crowi => {
  // const debug = Debug('crowi:models:revision')

  const revisionSchema = new Schema<RevisionDocument, RevisionModel>({
    path: { type: String, required: true, index: true },
    body: { type: String, required: true },
    format: { type: String, default: 'markdown' },
    author: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  })

  const Revision = model<RevisionDocument, RevisionModel>('Revision', revisionSchema)

  revisionSchema.statics.findLatestRevision = function(path, cb) {
    this.find({ path })
      .sort({ createdAt: -1 })
      .limit(1)
      .exec(function(err, data) {
        cb(err, data.shift())
      })
  }

  revisionSchema.statics.findRevision = function(id) {
    return new Promise(function(resolve, reject) {
      Revision.findById(id)
        .populate('author')
        .exec(function(err, data) {
          if (err) {
            return reject(err)
          }

          return resolve(data)
        })
    })
  }

  revisionSchema.statics.findRevisions = function(ids) {
    if (!Array.isArray(ids)) {
      return Promise.reject(new Error('The argument was not Array.'))
    }

    return new Promise(function(resolve, reject) {
      Revision.find({ _id: { $in: ids } })
        .sort({ createdAt: -1 })
        .populate('author')
        .exec(function(err, revisions) {
          if (err) {
            return reject(err)
          }

          return resolve(revisions)
        })
    })
  }

  revisionSchema.statics.findRevisionIdList = function(path) {
    return this.find({ path: path })
      .select('_id author createdAt')
      .sort({ createdAt: -1 })
      .exec()
  }

  revisionSchema.statics.findRevisionList = function(path, options) {
    return new Promise(function(resolve, reject) {
      Revision.find({ path: path })
        .sort({ createdAt: -1 })
        .populate('author')
        .exec(function(err, data) {
          if (err) {
            return reject(err)
          }

          return resolve(data)
        })
    })
  }

  revisionSchema.statics.updateRevisionListByPath = function(path, updateData, options) {
    return new Promise(function(resolve, reject) {
      Revision.update({ path: path }, { $set: updateData }, { multi: true }, function(err, data) {
        if (err) {
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  revisionSchema.statics.prepareRevision = function(pageData, body, user, options) {
    if (!options) {
      options = {}
    }
    var format = options.format || 'markdown'

    if (!user._id) {
      throw new Error('Error: user should have _id')
    }

    var newRevision = new Revision()
    newRevision.path = pageData.path
    newRevision.body = body
    newRevision.format = format
    newRevision.author = user._id
    newRevision.createdAt = Date.now()

    return newRevision
  }

  revisionSchema.statics.removeRevisionsByPath = function(path) {
    return Revision.remove({ path })
  }

  revisionSchema.statics.updatePath = function(pathName) {}

  revisionSchema.statics.findAuthorsByPage = function(page) {
    return new Promise(function(resolve, reject) {
      Revision.distinct('author', { path: page.path }).exec(function(err, authors) {
        if (err) {
          reject(err)
        }

        resolve(authors)
      })
    })
  }

  return Revision
}
