import { Express } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from '../utils/apiResponse'

export default (crowi: Crowi, app: Express) => {
  const actions = {} as any
  const api = {} as any

  actions.api = api

  /**
   * @api {get} /users.list Get user list
   */
  api.get = function(req, res) {
    return res.json(ApiResponse.success({ version: crowi.version }))
  }

  return actions
}
