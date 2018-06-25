module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:access')
  const mongoose = require('mongoose')
  const mongoosePaginate = require('mongoose-paginate')
  const ObjectId = mongoose.Schema.Types.ObjectId

  const accessSchema = new mongoose.Schema({
    tracking: { type: ObjectId, ref: 'Tracking', index: true },
    createdAt: { type: Date, default: Date.now },
  })
  accessSchema.plugin(mongoosePaginate)

  accessSchema.statics.findAccesses = async function(query, options = {}) {
    const self = this
    const page = options.page || 1
    const limit = options.limit || 50
    const sort = options.sort || { status: 1, username: 1, createdAt: 1 }

    return self.paginate(query, {
      page,
      limit,
      sort,
      populate: {
        path: 'tracking',
        model: 'Tracking',
      },
    })
  }

  return mongoose.model('Access', accessSchema)
}
