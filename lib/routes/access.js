module.exports = (crowi, app) => {
  'use strict'

  // const debug = require('debug')('crowi:routes:access')
  const Access = crowi.model('Access')
  const ApiResponse = require('../util/apiResponse')
  const actions = {}

  const api = (actions.api = {})

  api.list = async (req, res) => {
    let { page = 1, limit = 50 } = req.query
    page = parseInt(page)
    limit = parseInt(limit)
    const options = { page, limit }
    try {
      const accessData = await Access.findAccesses({}, options)
      const result = { access: accessData }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
