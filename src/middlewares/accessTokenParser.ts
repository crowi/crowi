import { Express, Request, Response, NextFunction } from 'express'
import Crowi from 'src/crowi'
import Debug from 'debug'
import { parseAccessToken } from 'src/util/accessTokenParser'

const debug = Debug('crowi:middlewares:accessTokenParser')

export default (crowi: Crowi, app: Express) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const accessToken = parseAccessToken(req)
    if (!accessToken) {
      return next()
    }

    const User = crowi.model('User')

    debug('accessToken is', accessToken)
    User.findUserByApiToken(accessToken)
      .then(function (userData) {
        req.user = userData
        req.skipCsrfVerify = true
        debug('Access token parsed: skipCsrfVerify')

        next()
      })
      .catch(function (err) {
        next()
      })
  }
}
