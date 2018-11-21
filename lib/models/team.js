const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

const handleRegex = /^[\da-zA-Z\-_.]+$/ // same as username (see form/register.js)
const schema = new mongoose.Schema({
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
})

// static methods

/**
 * Find teams by user
 * @param {User} user
 * @returns {Promise<Teams[]>}
 */
schema.statics.findByUser = async function(user) {
  if (!(user instanceof mongoose.model('User'))) throw new TypeError()

  return this.find({
    users: user._id,
  }).exec()
}

/**
 * Find team by handle
 * FIXME: Judge findOneByHandle OR findByHandle
 * Now this is findByHandle, looks like mongoose API, such as findById
 * @param {string} handle
 * @returns {Promise<Team>}
 */
schema.statics.findByHandle = async function(handle) {
  if (typeof handle !== 'string') throw new TypeError()

  return this.findOne({
    handle,
  }).exec()
}

/**
 * Add user to team
 * @param {Team} team to add
 * @param {User[]} users will be added
 * @returns {Promise<Team>} edited team
 */
schema.statics.addUser = async function(team, ...users) {
  const User = mongoose.model('User')

  if (!(team instanceof this)) throw new TypeError()
  if (team.isNew) throw new TypeError('You must give the team saved, not new one.')

  if (users.length === 0 || users.filter(user => user instanceof User).length !== users.length) throw new TypeError()

  team.users.addToSet(...users)
  return team.save()
}

/**
 * Delete user from team
 * @param {Team} team to delete
 * @param {User[]} users will be deleted
 * @returns {Promise<Team>} edited team
 */
schema.statics.deleteUser = async function(team, ...users) {
  if (!(team instanceof mongoose.model('Team'))) throw new TypeError()
  if (team.isNew) throw new TypeError('You must give the team saved, not new one.')

  if (users.length === 0 || users.filter(user => user instanceof mongoose.model('User')).length !== users.length) throw new TypeError()

  team.users.pull(...users)
  return team.save()
}

// instance methods

/**
 * Shorthand of static methods
 */
schema.methods.deleteUser = async function(...args) {
  return this.constructor.deleteUser(this, ...args)
}
schema.methods.addUser = async function(...args) {
  return this.constructor.addUser(this, ...args)
}

/**
 * Get pages owned by team
 * @param {string} fieldsOnPageWillBeSelected page fields
 * @returns {Promise<Page[]>}
 */
schema.methods.getPagesOwned = async function(fieldsOnPageWillBeSelected = null) {
  const pages = (await mongoose
    .model('PageOwner')
    .find({ team: this, isActive: true }, '_id page')
    .populate('page', fieldsOnPageWillBeSelected)
    .exec()).map(doc => doc.page) // FIXME: use lean?

  return pages
}

/**
 * Own the page
 * @param {Page} page will be owned.
 * @returns {Promise<boolean>} with populated 'team' field
 */
schema.methods.ownPage = async function(page) {
  const { PreconditionError } = this.constructor.crowi().errors

  if (!(page instanceof mongoose.model('Page'))) throw new TypeError()
  if (page.isNew) throw new TypeError('You must give the page saved, not new one.')
  // FIXME: この責務分割でいいのかなあ。。。
  if (!page.canBeOwned()) throw new PreconditionError("You can't own userpage, non public or deleted page.")

  const owner = await mongoose
    .model('PageOwner')
    .findOneAndUpdate(
      {
        team: this._id,
        page,
        isActive: true,
      },
      {
        $setOnInsert: {
          team: this._id,
          page: page._id,
        },
      },
      { upsert: true, new: true },
    )
    .exec()

  return owner !== null // FIXME: すでに own してある (すでに) ケースでも true になるけどいい？
}

/**
 * Disown the page
 * @param {Page} page will be disowned
 * @returns {Promise<boolean>}
 * @throws {PermissionError} will be raised when you want to disown the page that not owned by your team
 */
schema.methods.disownPage = async function(page) {
  const { PreconditionError } = this.constructor.crowi().errors

  if (!(page instanceof mongoose.model('Page'))) throw new TypeError()
  if (page.isNew) throw new TypeError('You must give the page saved, not new one.')

  const owner = await mongoose
    .model('PageOwner')
    .findOneAndUpdate(
      { team: this, page, isActive: true },
      {
        isActive: false,
        inactivatedAt: Date.now(),
      },
      {
        new: true,
      },
    )
    .exec()

  if (owner === null) throw new PreconditionError('There are no owner specified.')

  return true
}

/**
 * Construct Team model
 * @param {Crowi} crowi /lib/crowi
 */
module.exports = crowi => {
  // Make crowi instance available in methods
  schema.statics.crowi = () => crowi

  return mongoose.model('Team', schema)
}
