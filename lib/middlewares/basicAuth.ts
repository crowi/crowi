import { Express, Request, Response } from 'express'
import Crowi from 'server/crowi'
import basicAuth from 'basic-auth-connect'
import { parseAccessToken } from '../utils/accessTokenParser'

export default (crowi: Crowi, app: Express) => {
  return (req: Request, res: Response, next) => {
    const config = crowi.getConfig()
    const accessToken = parseAccessToken(req)
    if (accessToken) {
      return next()
    }

    if (config.crowi['security:basicName'] && config.crowi['security:basicSecret']) {
      return basicAuth(config.crowi['security:basicName'], config.crowi['security:basicSecret'])(req, res, next)
    } else {
      next()
    }
  }
}
