module.exports = function(crowi, app) {
  'use strict'

  const ApiResponse = require('../util/apiResponse')
  const actions = {}
  const api = {}

  actions.api = api

  /**
   * @api {get} /users.list Get user list
   */
  api.get = function(req, res) {
    return res.json(ApiResponse.success({ version: crowi.version }))
  }

  return actions
}
