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
 * Find active page owner configurations by team(s)
 * @argument {Team[]|ObjectId[]} ...teams
 * @returns {Promise<PageOwner[]>}
 */
schema.statics.findByTeam = function(...teams) {
  return this.find({ team: { $in: teams }, isActive: true }).exec()
}

/**
 * Find active page owner configurations by page
 * @argument {Page|ObjectId} page
 * @returns {Promise<PageOwner[]>}
 */
schema.statics.findByPage = function(page) {
  return this.find({ page, isActive: true }).exec()
}

/**
 * Find an active page owner configuration by page & team
 * @argument {Object} target
 * @argument {Page|ObjectId} target.page
 * @argument {Team|ObjectId} target.team
 * @returns {Promise<PageOwner|null>}
 */
schema.statics.findByPageAndTeam = async function({ page, team }) {
  if (!page || !team) throw new TypeError('There are missing arguments!')

  return this.findOne({ team, page, isActive: true }).exec()
}

/**
 * Activate page owner configuration page<->team relationship
 * @argument {Object} target
 * @argument {Page} target.page
 * @argument {Team} target.team
 * @returns {Promise<PageOwner>}
 */
schema.statics.activate = async function({ page, team }) {
  const { PreconditionError } = this.crowi().errors

  if (!page || !team) throw new TypeError('There are missing arguments!')

  // Block non page/team
  if (!(page instanceof mongoose.model('Page'))) throw new TypeError()
  if (!(team instanceof mongoose.model('Team'))) throw new TypeError()

  // Block new (not saved) page/team at now
  // at future this restriction will be removed.
  if (page.isNew) throw new TypeError(`You must give the page saved, not new one.`)
  if (team.isNew) throw new TypeError(`You must give the team saved, not new one.`)

  if (!page.canBeOwned()) throw new PreconditionError("You can't own userpage, non public or deleted page.")

  return this.findOneAndUpdate(
    {
      team,
      page,
      isActive: true,
    },
    {
      $setOnInsert: {
        team: team._id,
        page: page._id,
      },
    },
    { upsert: true, new: true },
  ).exec()
}

/**
 * Deactivate page owner configuration
 * @argument {PageOwner}
 */
schema.methods.deactivate = function() {
  return this.update(
    {
      isActive: false,
      inactivatedAt: Date.now(),
    },
    {
      new: true,
    },
  ).exec()
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
