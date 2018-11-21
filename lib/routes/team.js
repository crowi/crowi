const debug = require('debug')('crowi:routes:team')

const { Router } = require('express')
const mongoose = require('mongoose')

const Team = mongoose.model('Team')
const User = mongoose.model('User')
const Page = mongoose.model('Page')
const ApiResponse = require('../util/apiResponse')

const wrap = fn => async (...args) => fn(...args).catch(args[2])

const api = {}
const middleware = {}

api.list = wrap(async (_, res) => {
  const teams = await Team.find({})
    .populate('users', User.USER_PUBLIC_FIELDS)
    .lean(true)
  res.json(ApiResponse.success({ teams }))
})

/**
 * @api {post} /teams.create Create team
 * @apiGroup Team
 *
 * @apiParam {String} handle
 * @apiParam {String|String[]} userids? list of User.id
 * @apiParam {String} name?
 * @apiParam {String}
 */
api.create = wrap(async (req, res) => {
  let { handle, userids, name } = req.body

  if (userids) {
    const expected = await User.find({
      _id: {
        $in: typeof userids === 'string' ? userids.split(' ') : userids,
      },
    })
      .select('_id')
      .lean()
    if (expected.length !== userids.length) return res.status(400).json(ApiResponse.error('There are missing users with given id.'))
  }

  const team = new Team({ handle, users: userids, name })
  try {
    const t = await team.save()
    res.json(ApiResponse.success({ _id: t._id }))
  } catch (e) {
    return res.status(400).json(ApiResponse.error(e))
  }
})

api.edit = wrap(async (req, res) => {
  const { id, name } = req.body

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  team.name = name
  res.json(ApiResponse.success())
})

api.addUser = wrap(async (req, res) => {
  const { id, userids } = req.body
  if (!userids) {
    return res.status(400).json(ApiResponse.error('userid is missing'))
  }

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  const users = await User.find({
    _id: {
      $in: typeof userids === 'string' ? userids.split(' ') : userids,
    },
  }).select('_id')
  if (users.length !== userids.length) return res.status(400).json(ApiResponse.error('There are missing users with given id.'))

  await team.addUser(...users)
  return res.json(ApiResponse.success())
})

api.deleteUser = wrap(async (req, res) => {
  const { id, userids } = req.body
  if (!userids) {
    return res.status(400).json(ApiResponse.error('userid is missing'))
  }

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  const users = await User.find({
    _id: {
      $in: typeof userids === 'string' ? userids.split(' ') : userids,
    },
  }).select('_id')
  if (users.length !== userids.length) return res.status(400).json(ApiResponse.error('There are missing users with given id.'))

  await team.deleteUser(...users)
  return res.json(ApiResponse.success())
})

api.ownPage = wrap(async (req, res) => {
  const { id, page } = req.body

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  const p = await Page.findById(page).select('_id path')

  const s = await team.ownPage(p)
  return s ? res.json(ApiResponse.success()) : res.status(500).json(ApiResponse.error()) // FIXME: more explain
})

api.disownPage = wrap(async (req, res) => {
  const { id, page } = req.body

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  const p = await Page.findById(page).select('_id path')

  await team.disownPage(p)
  return res.json(ApiResponse.success())
})

module.exports = crowi => {
  middleware.handleError = (e, _, res) => {
    debug(e)

    if (e instanceof crowi.errors.PreconditionError) {
      return res.status(400).json(ApiResponse.error(e.message || 'There are conditional error.'))
    }
    if (e instanceof TypeError) {
      return res.status(400).json(ApiResponse.error(e.message || 'There are type error.'))
    }
    return res.json(ApiResponse.error(e))
  }

  return {
    api,
    middleware,
  }
}
