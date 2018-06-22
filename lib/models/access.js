module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:access')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  let accessSchema

  accessSchema = new mongoose.Schema({
    tracking: { type: ObjectId, ref: 'Tracking', index: true },
    createdAt: { type: Date, default: Date.now },
  })

  return mongoose.model('Access', accessSchema)
}
