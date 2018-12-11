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

/**
 * Query helper: check whether active.
 */
schema.query.activated = function() {
  return this.where('isActive', true)
}

/**
 * Query helpers: shorthanded populate
 */
schema.query.populateTeam = function () {
  return this.populate({ path: 'team' })
}
schema.query.populatePage = function () {
  return this.populate({ path: 'page' })
}
schema.query.populateAll = function () {
  return this.populateTeam().populatePage()
}

/**
 * Find active page owner configurations by team(s)
 * @argument {Team[]|ObjectId[]} ...teams
 * @returns {mongoose.Query} similar to Promise<PageOwner|null>
 */
schema.statics.findByTeam = function(...teams) {
  return this.where('team')
    .in(teams)
    .activated()
}

/**
 * Find active page owner configurations by page
 * @argument {Page|ObjectId} page
 * @returns {mongoose.Query} similar to Promise<PageOwner|null>
 */
schema.statics.findByPage = function(page) {
  return this.where({ page }).activated()
}

/**
 * Find an active page owner configuration by page & team
 * @argument {Object} target
 * @argument {Page|ObjectId} target.page
 * @argument {Team|ObjectId} target.team
 * @returns {mongoose.Query} similar to Promise<PageOwner|null>
 */
schema.statics.findByPageAndTeam = function({ page, team }) {
  if (!page || !team) throw new TypeError('There are missing arguments!')

  return this.where({ team, page }).activated()
}

/**
 * Activate page owner configuration page<->team relationship
 * @argument {Object} target
 * @argument {Page} target.page
 * @argument {Team} target.team
 * @returns {Promise<PageOwner>}
 * @throws {TypeError} when argument missing, documents have incorrect parent model given and new document given (new document).
 * @throws {PreconditionError} when page can not be owned
 */
schema.statics.activate = async function({ page, team }) {
  const { PreconditionError } = this.crowi().errors

  if (!page || !team) throw new TypeError('There are missing arguments!')

  // Block non page/team
  if (!(page instanceof mongoose.model('Page'))) throw new TypeError()
  if (!(team instanceof mongoose.model('Team'))) throw new TypeError()

  // Block new (not saved) page/team at now
  // at future this restriction will be removed
  // to set owner to new page.
  if (page.isNew) throw new TypeError(`You must give the page saved, not new one.`)
  if (team.isNew) throw new TypeError(`You must give the team saved, not new one.`)

  if (!page.canBeOwned()) throw new PreconditionError("You can't own userpage, non public or deleted page.")

  const doc = await this.findByPageAndTeam({ team, page })
    .setOptions({ upsert: true, new: true })
    .findOneAndUpdate({
      $setOnInsert: {
        team: team._id,
        page: page._id,
      },
    })
    .exec()

  // manual population
  doc.page = page
  doc.team = team
  return doc
}

/**
 * Deactivate page owner configuration
 * @argument {Object} target
 * @argument {Page} target.page
 * @argument {Team} target.team
 * @throws {TypeError} when argument missing or documents have incorrect parent model given.
 * @return {Promise<PageOwner|null>} returns null when there are no page owner configuration with given condition.
 */
schema.statics.deactivate = async function({ page, team }) {
  if (!page || !team) throw new TypeError('There are missing arguments!')

  // Block non page/team
  if (!(page instanceof mongoose.model('Page'))) throw new TypeError()
  if (!(team instanceof mongoose.model('Team'))) throw new TypeError()

  const doc = await this.findByPageAndTeam({ team, page })
    .setOptions({ new: true })
    .findOneAndUpdate({
      $set: {
        isActive: false,
        inactivatedAt: Date.now(),
      },
    })
    .exec()

  // manual populate
  doc.page = page
  doc.team = team

  return doc
}

/**
 * Construct Team model
 * @param {Crowi} crowi /lib/crowi
 */
module.exports = crowi => {
  // Make crowi instance available in methods
  schema.statics.crowi = () => crowi

  return mongoose.model('PageOwner', schema)
}
