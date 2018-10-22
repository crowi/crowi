const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

const schema = new mongoose.Schema({
  users: { type: [ObjectId], ref: 'User', index: true, validate: (v) => {
    return Array.isArray(v) // to prevent null
  }},
  handle: { type: String, index: true, unique: true, required: true }, /* ex: "acme", used as @team-acme */
  name: String, /** ex. "The ACME Team" */
  createdAt: { type: Date, default: Date.now }
})

/**
 * Find teams by user
 * @param {User} user
 */
schema.statics.findByUser = async function (user) {
  return this.find({
    users: user._id
  })
}

/**
 * Add user to team
 * @param {Team} team to add
 * @param {User[]} users will be added
 * @returns {Promise<Team>}
 */
schema.statics.addUser = async function (team, ...users) {
  return this.findByIdAndUpdate(team._id,
    {
      $push: {
        users: { $each: users.map(user => user._id) }
      }
    },
    {
      new: true
    }
  ).exec()
}
// suger
schema.methods.addUser = async function (...users) {
  return this.constructor.addUser(this, ...users)
}

/**
 * Delete user from team
 * @param {Team} team to delete
 * @param {User[]} users will be deleted
 * @returns {Promise<Team>}
 */
schema.statics.deleteUser = async function (team, ...users) {
  return this.findByIdAndUpdate(team._id,
    {
      $pull: {
        users: { $in: users.map(user => user._id) }
      }
    },
    {
      new: true
    }
  ).exec()
}
// suger
schema.methods.deleteUser = async function (...users) {
  return this.constructor.deleteUser(this, ...users)
}

module.exports = (_) => {
  return mongoose.model('Team', schema)
}
