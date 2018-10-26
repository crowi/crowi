const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

const schema = new mongoose.Schema({
  team: { type: ObjectId, ref: 'Team', required: true },
  page: { type: ObjectId, ref: 'Page', required: true },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  inactivatedAt: Date,
})
schema.index(
  { team: 1, page: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isActive: true,
    },
  },
)

// static methods

/**
 * Construct Team model
 * @param {Crowi} crowi /lib/crowi
 */
module.exports = crowi => {
  // Make crowi instance available in methods
  schema.statics.crowi = () => crowi

  return mongoose.model('PageOwner', schema)
}
