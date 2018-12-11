module.exports = function(crowi) {
  'use strict'

  const Page = crowi.model('Page')
  const Team = crowi.model('Team')
  const PageOwner = crowi.model('PageOwner')
  const ApiResponse = require('../util/apiResponse')

  const actions = {}
  const api = (actions.api = {})

  // Promise rejection to express callback
  const wrap = fn => async (...args) => fn(...args).catch(args[2])

  api.activate = wrap(async (req, res) => {
    const { id, page } = req.body

    const team = await Team.findById(id)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    const p = await Page.findById(page).select('_id path')

    const s = await PageOwner.activate({ page: p, team })
    return s ? res.json(ApiResponse.success()) : res.status(500).json(ApiResponse.error()) // FIXME: more explain
  })

  api.deactivate = wrap(async (req, res) => {
    const { id, page } = req.body

    const team = await Team.findById(id)
    if (!team) return res.status(404).json(ApiResponse.error('There are no team with given id.'))

    const p = await Page.findById(page).select('_id path')

    const dp = await PageOwner.disownPage({ page: p, team })
    if (!dp) return res.status(404).json(ApiResponse.error('There are no owner configuration.'))
    return res.json(ApiResponse.success())
  })

  return actions
}
