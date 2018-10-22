const mongoose = require('mongoose')
const { ObjectId } = mongoose.Schema.Types

const schema = new mongoose.Schema({
  users: {
    type: [ObjectId],
    ref: 'User',
    index: true,
    validate: v => {
      return Array.isArray(v) // to prevent null
    },
  },
  handle: {
    type: String,
    index: true,
    unique: true,
    required: true,
    validate: [
      handle => /^[\da-zA-Z\-_.]+$/.test(handle), // same as username (see form/register.js)
      '{PATH} must be in the range of /^[da-zA-Z-_.]+$/, got {VALUE}',
    ],
  } /* ex: "acme", used as @team-acme */,
  name: String /** ex. "The ACME Team" */,
  createdAt: { type: Date, default: Date.now },
})
schema.virtual('pages', {
  ref: 'Page',
  localField: '_id',
  foreignField: 'owner',
  justOne: false
})

// static methods

/**
 * Find teams by user
 * @param {User} user
 */
schema.statics.findByUser = async function(user) {
  return this.find({
    users: user._id,
  }).exec()
}

/**
 * Find team by handle
 * @param {String} handle
 */
schema.statics.findOneByHandle = async function(handle) {
  return this.findOne({
    handle,
  }).exec()
}

/**
 * Add user to team
 * @param {Team} team to add
 * @param {User[]} users will be added
 * @returns {Promise<Team>}
 */
schema.statics.addUser = async function(team, ...users) {
  return this.findByIdAndUpdate(
    team._id,
    {
      $push: {
        users: { $each: users.map(user => user._id) },
      },
    },
    {
      new: true,
    },
  ).exec()
}

/**
 * Delete user from team
 * @param {Team} team to delete
 * @param {User[]} users will be deleted
 * @returns {Promise<Team>}
 */
schema.statics.deleteUser = async function(team, ...users) {
  return this.findByIdAndUpdate(
    team._id,
    {
      $pull: {
        users: { $in: users.map(user => user._id) },
      },
    },
    {
      new: true,
    },
  ).exec()
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
 * @returns {Promise<Page[]>}
 */
schema.methods.getOwnedPages = async function () {
  const { pages } = await this.populate('pages').execPopulate()
  return pages
}

/**
 * Own the page
 * @param {Page} page will be owned. # TODO: bulk insert?
 * @returns {Promise<Page>} with populated 'team' field
 */
schema.methods.ownPage = async function (page) {
  // force apply
  page.owner = this._id

  const savedPage = await page.save()

  // manually populate
  savedPage.team = this // FIXME: これ問題ないのか疑問. 複製したほうがいいのかな (deep clone)
  return savedPage
}

/**
 * Disown the page
 * @param {Page} page will be disowned
 * @returns {Promise<Page>}
 * @throws 
 */
schema.methods.disownPage = async function (page) {
  if (page.owner !== this._id) throw new Error("It can't disown pages that owned by other teams.") // TODO: カスタムエラー作る
  page.owner = null

  const savedPage = await page.save()

  return savedPage
}

/**
 * Construct Team model
 * @param {Crowi} _ lib/crowi
 */
module.exports = _ => {
  return mongoose.model('Team', schema)
}
