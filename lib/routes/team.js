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
   * @apiParam {String|String[]} user_ids? list of User.id
   * @apiParam {String} name?
   */
  api.create = wrap(async (req, res) => {
    let { handle, user_ids: userIds, name } = req.body

    const user = await User.create({ handle, users: userIds, name })
    res.json(ApiResponse.success({ _id: user._id }))
  })

  /**
   * @api {post} /teams.edit Edit team
   * @apiGroup Team
   *
   * @apiParam {String} handle
   * @apiParam {String|String[]} user_ids? list of User.id
   * @apiParam {String} name?
   */
  api.edit = wrap(async (req, res) => {
    const { team_id: teamId, name, user_ids: userIds } = req.body

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    await team.edit({ name, users: userIds })
    res.json(ApiResponse.success())
  })

  return {
    api,
  }
}
