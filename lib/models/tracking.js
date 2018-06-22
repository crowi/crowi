module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:tracking')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  let trackingSchema

  trackingSchema = new mongoose.Schema({
    userAgent: { type: String, required: true },
    remoteAddress: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  })

  return mongoose.model('Tracking', trackingSchema)
}
