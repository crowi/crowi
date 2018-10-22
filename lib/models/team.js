const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

const schema = new mongoose.Schema({
  users: { type: [ObjectId], ref: 'User', index: true, validate: (v) => {
    return Array.isArray(v) // to prevent null
  }},
  handle: { type: String, index: true, unique: true, required: true, validate: [
    (handle) => /^[\da-zA-Z\-_.]+$/.test(handle), // same as username (see form/register.js)
    '{PATH} must be in the range of /^[\da-zA-Z\-_.]+$/, got {VALUE}'
  ]}, /* ex: "acme", used as @team-acme */
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
  }).exec()
}

/**
 * Find team by handle
 * @param {String} handle
 */
schema.statics.findOneByHandle = async function (handle) {
  return this.findOne({
    handle
  }).exec()
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
schema.methods.addUser = async function (...args) {
  return this.constructor.addUser(this, ...args)
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
schema.methods.deleteUser = async function (...args) {
  return this.constructor.deleteUser(this, ...args)
}

/**
 * Construct Team model
 * @param {Crowi} _ lib/crowi
 */
module.exports = (_) => {
  return mongoose.model('Team', schema)
}
