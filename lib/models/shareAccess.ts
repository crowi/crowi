import { Types, Document, Model, Schema, Query, model } from 'mongoose'
import Debug from 'debug'
import mongoosePaginate from 'mongoose-paginate'

export interface ShareAccessDocument extends Document {
  share: Types.ObjectId
  tracking: Types.ObjectId
  createdAt: Date
  lastAccessedAt: Date
}

export default crowi => {
  // const debug = Debug('crowi:models:shareAccess')

  const shareAccessSchema = new Schema<ShareAccessDocument>({
    share: { type: Schema.Types.ObjectId, ref: 'Share', index: true },
    tracking: { type: Schema.Types.ObjectId, ref: 'Tracking', index: true },
    createdAt: { type: Date, default: Date.now },
    lastAccessedAt: { type: Date, default: Date.now },
  })
  shareAccessSchema.index({ share: 1, tracking: 1 }, { unique: true })
  shareAccessSchema.plugin(mongoosePaginate)

  shareAccessSchema.statics.findAccesses = async function(query, options = {}) {
    const page = options.page || 1
    const limit = options.limit || 50
    const sort = options.sort || { lastAccessedAt: -1 }

    return this.paginate(query, {
      page,
      limit,
      sort,
      populate: [
        {
          path: 'tracking',
          model: 'Tracking',
        },
        {
          path: 'share',
          model: 'Share',
          populate: ['page', 'creator'],
        },
      ],
    })
  }

  shareAccessSchema.statics.access = async function(shareId, trackingId) {
    const query = { share: shareId, tracking: trackingId }
    const update = { lastAccessedAt: Date.now() }
    return this.findOneAndUpdate(query, update, { upsert: true, new: true }).exec()
  }

  return model('ShareAccess', shareAccessSchema)
}
