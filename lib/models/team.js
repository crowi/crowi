const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

/**
 * Construct Team model
 * @param {Crowi} crowi /lib/crowi
 */
module.exports = crowi => {
  const handleRegex = /^[\da-zA-Z\-_.]+$/ // same as username (see form/register.js)
  const teamSchema = new mongoose.Schema(
    {
      users: [
        {
          type: ObjectId,
          ref: 'User',
          index: true,
        },
      ],
      handle: {
        type: String,
        index: true,
        unique: true,
        required: true,
        validate: [handle => handleRegex.test(handle), `{PATH} must be in the range of ${handleRegex}, got {VALUE}`],
      } /* ex: "acme", used as @team-acme */,
      name: String /** ex. "The ACME Team" */,
      createdAt: { type: Date, default: Date.now },
    },
    {
      toJSON: { virtuals: true },
    },
  )
  teamSchema.virtual('pageOwners', {
    ref: 'PageOwner',
    localField: '_id',
    foreignField: 'team',
  })

  // query helper methods
  teamSchema.query.populateUsers = function() {
    const User = crowi.model('User')
    return this.populate({
      path: 'users',
      select: User.USER_PUBLIC_FIELDS,
    })
  }
  teamSchema.query.populatePageOwners = function() {
    return this.populate({
      path: 'pageOwners',
      match: { isActive: true },
      select: '_id page team',
      populate: {
        path: 'page',
      },
    })
  }
  teamSchema.query.populateAll = function() {
    return this.populateUsers().populatePageOwners()
  }

  // static methods

  /**
   * Find teams by user
   * @param {User|ObjectId} user
   * @returns {mongoose.Query} similar to Promise<Team[]>
   */
  teamSchema.statics.findByUser = function(user) {
    if (!(user instanceof crowi.model('User') || mongoose.Types.ObjectId.isValid(user))) throw new TypeError()

    return this.find({
      users: mongoose.Types.ObjectId.isValid(user) ? user : user._id,
    })
  }

  /**
   * Find team by handle
   * @param {string} handle
   * @returns {mongoose.Query} similar to Promise<Team>
   */
  teamSchema.statics.findByHandle = function(handle) {
    if (typeof handle !== 'string') throw new TypeError()

    return this.findOne({
      handle,
    })
  }

  // instance methods

  /**
   * Delete user from team
   * @param {User[]|ObjectId} users will be deleted
   * @returns {Promise<Team>} edited team
   */
  teamSchema.methods.deleteUser = async function(...users) {
    if (users.length === 0 || users.filter(user => user instanceof crowi.model('User') || mongoose.Types.ObjectId.isValid(user)).length !== users.length)
      throw new TypeError()
    this.users.pull(...users)

    return this.save()
  }
  /**
   * Add user from team
   * @param {User[]|ObjectId} users will be added
   * @returns {Promise<Team>} edited team
   */
  teamSchema.methods.addUser = async function(...users) {
    if (users.length === 0 || users.filter(user => user instanceof crowi.model('User') || mongoose.Types.ObjectId.isValid(user)).length !== users.length)
      throw new TypeError()
    this.users.addToSet(...users)

    return this.save()
  }

  return mongoose.model('Team', teamSchema)
}
