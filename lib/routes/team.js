const { Router } = require('express')
const mongoose = require('mongoose')

const Team = mongoose.model('Team')
const User = mongoose.model('User')
const ApiResponse = require('../util/apiResponse')

const api = Router()

api.get('/teams.list', async (_, res) => {
  const teams = await Team.find({})
    .populate('users', '_id image name username')
    .lean(true)
  res.json(ApiResponse.success(teams))
})

/**
 * @api {post} /teams/create Create team
 * @apiGroup Team
 *
 * @apiParam {String} handle
 * @apiParam {String|String[]} userids? list of User.id
 * @apiParam {String} name?
 * @apiParam {String}
 */
api.post('/teams.create', async (req, res) => {
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

api.post('/teams.edit', async (req, res) => {
  const { id, name } = req.body

  const team = await Team.findById(id)
  if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

  team.name = name
  res.json(ApiResponse.success())
})

api.post('/teams.addUser', async (req, res) => {
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
api.post('/teams.deleteUser', async (req, res) => {
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

module.exports = () => {
  return {
    api,
  }
}
