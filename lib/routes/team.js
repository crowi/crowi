const debug = require('debug')('crowi:routes:team')
const ApiResponse = require('../util/apiResponse')

module.exports = (crowi, app) => {
  'use strict'
  const Team = crowi.model('Team')
  const User = crowi.model('User')

  // Promise rejection to express callback
  const wrap = fn => async (...args) => fn(...args).catch(args[2])

  const api = {}

  /**
   * @api {get} /teams.list List all team
   * @apiGroup Team
   */
  api.list = wrap(async (_, res) => {
    const teams = await Team.find()
      .populateUsers()
      .lean(true)
    res.json(ApiResponse.success({ teams }))
  })

  /**
   * @api {get} /teams.get Get team with given ID
   * @apiGroup Team
   *
   * @apiParam {String} team_id
   */
  api.get = wrap(async (req, res) => {
    const { team_id: teamId } = req.query
    const team = await Team.findById(teamId).populateAll()
    res.json(ApiResponse.success({ team }))
  })

  /**
   * @api {post} /teams.create Create team
   * @apiGroup Team
   *
   * @apiParam {String} handle
   * @apiParam {String|String[]} userids? list of User.id
   * @apiParam {String} name?
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

  /**
   * @api {post} /teams.edit Edit team
   * @apiGroup Team
   *
   * @apiParam {String} team_id Team's ObjectId to edit
   * @apiParam {String} name?
   */
  api.edit = wrap(async (req, res) => {
    const { team_id: teamId, name } = req.body

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    team.name = name
    res.json(ApiResponse.success())
  })

  /**
   * @api {post} /teams.addUser Add users to team
   * @apiGroup Team
   *
   * @apiParam {String} team_id Team's ObjectId to edit
   * @apiParam {String|String[]} userids? list of User.id
   */
  api.addUser = wrap(async (req, res) => {
    const { team_id: teamId, userids } = req.body
    if (!userids) {
      return res.status(400).json(ApiResponse.error('userid is missing'))
    }

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    // TODO: move this inside team model
    const users = await User.find({
      _id: {
        $in: typeof userids === 'string' ? userids.split(' ') : userids,
      },
    }).select('_id')
    if (users.length !== userids.length) return res.status(400).json(ApiResponse.error('There are missing users with given id.'))

    await team.addUser(...users)
    return res.json(ApiResponse.success())
  })

  /**
   * @api {post} /teams.deleteUser Delete users to team
   * @apiGroup Team
   *
   * @apiParam {String} id Team's ObjectId to edit
   * @apiParam {String|String[]} userids? list of User.id
   */
  api.deleteUser = wrap(async (req, res) => {
    const { team_id: teamId, userids } = req.body
    if (!userids) {
      return res.status(400).json(ApiResponse.error('userid is missing'))
    }

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    // TODO: move this inside team model
    const users = await User.find({
      _id: {
        $in: typeof userids === 'string' ? userids.split(' ') : userids,
      },
    }).select('_id')
    if (users.length !== userids.length) return res.status(400).json(ApiResponse.error('There are missing users with given id.'))

    await team.deleteUser(...users)
    return res.json(ApiResponse.success())
  })

  const middleware = {}

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
