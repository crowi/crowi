module.exports = function(crowi) {
  // const debug = require('debug')('crowi:models:shareAccess')
  const mongoose = require('mongoose')
  const mongoosePaginate = require('mongoose-paginate')
  const ObjectId = mongoose.Schema.Types.ObjectId

  const shareAccessSchema = new mongoose.Schema({
    share: { type: ObjectId, ref: 'Share', index: true },
    tracking: { type: ObjectId, ref: 'Tracking', index: true },
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

  return mongoose.model('ShareAccess', shareAccessSchema)
}
