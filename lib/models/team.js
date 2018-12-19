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
  teamSchema.path('users').validate(v => v.length > 0, '{PATH} must contain at least one user.')
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

  /**
   * Create team.
   * @param {Object} option
   * @param {string} [option.name]
   * @param {string} option.handle
   * @param {User[]|ObjectId[]} option.users must >1 users
   * @returns {Promise<Team>}
   * @throws {TypeError}
   * @throws {mongoose.ValidationError}
   */
  teamSchema.statics.create = async function({ name = null, handle, users }) {
    const Team = this
    const User = crowi.model('User')

    const team = new Team()
    team.name = name
    team.handle = handle

    const userIds = users.map(user => {
      if (user instanceof User) return user._id
      if (!mongoose.Types.ObjectId.isValid(user)) throw new TypeError('There are invalid id in users.')
      return user
    })
    const expectedUsers = await User.find({
      _id: {
        $in: userIds,
      },
    })
      .select('_id')
      .lean()
    if (expectedUsers.length !== userIds.length) throw new TypeError('There are missing users with given id.')
    team.users = expectedUsers

    return team.save()
  }

  // instance methods

  /**
   * Edit team
   * If no option given, this method returns 'this' directly.
   * FIXME: This method isn't idempotent.
   * @param {Object} [option]
   * @param {string} [option.name]
   * @param {User[]|ObjectId[]} [option.users]
   * @returns {Promise<Team>}
   * @throws {TypeError}
   * @throws {mongoose.ValidationError}
   */
  teamSchema.methods.edit = async function({ name = null, users = null } = {}) {
    const User = mongoose.model('User')

    if (Array.isArray(users)) {
      const userIds = users.map(user => {
        if (user instanceof crowi.model('User')) return user._id
        if (!mongoose.Types.ObjectId.isValid(user)) throw new TypeError('There are invalid id in users.')
        return user
      })
      const expectedUsers = await User.find({
        _id: {
          $in: userIds,
        },
      })
        .select('_id')
        .lean()
      if (expectedUsers.length !== userIds.length) throw new TypeError('There are missing users with given id.')

      this.users = expectedUsers
    }
    if (name) this.name = name

    return this.save()
  }

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
