const debug = require('debug')('crowi:routes:pageOwner')
const ApiResponse = require('../util/apiResponse')

module.exports = (crowi, app) => {
  'use strict'
  const Page = crowi.model('Page')
  const Team = crowi.model('Team')
  const PageOwner = crowi.model('PageOwner')

  // Promise rejection to express callback
  const wrap = fn => async (...args) => fn(...args).catch(args[2])

  const api = {}

  /**
   * @api {post} /page_owners.activate Activate page owner configuration
   * @apiGroup PageOwner
   *
   * @apiParam {String} team team's ObjectId
   * @apiParam {String} page page's ObjectId
   */
  api.activate = wrap(async (req, res) => {
    const { team: teamId, page: pageId } = req.body

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    const page = await Page.findById(pageId).select('_id path')

    const s = await PageOwner.activate({ page, team })
    return s ? res.json(ApiResponse.success()) : res.status(500).json(ApiResponse.error()) // FIXME: more explain
  })

  /**
   * @api {post} /page_owners.deactivate Deactivate page owner configuration
   * @apiGroup PageOwner
   *
   * @apiParam {String} team team's ObjectId
   * @apiParam {String} page page's ObjectId
   */
  api.deactivate = wrap(async (req, res) => {
    const { team: teamId, page: pageId } = req.body

    const team = await Team.findById(teamId)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    const page = await Page.findById(pageId).select('_id path')

    const dp = await PageOwner.deactivate({ page, team })
    if (!dp) return res.status(404).json(ApiResponse.error('There are no owner configuration.'))
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
    middleware,
    api,
  }
}
