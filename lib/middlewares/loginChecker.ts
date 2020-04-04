import { Express, Request, Response, NextFunction } from 'express'
import Crowi from 'server/crowi'
// const debug = Debug('crowi:middlewares:loginChecker')

export default (crowi: Crowi, app: Express) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const User = crowi.model('User')
    const csrfKey = req.session?.id || 'anon'

    if (!req.csrfToken) {
      req.csrfToken = crowi.getTokens().create(csrfKey)
    }

    // session に user object が入ってる
    if (req.session?.user && '_id' in req.session.user) {
      User.findById(req.session.user._id, '+password +apiToken', function(err, userData) {
        if (err) {
          next()
        } else {
          req.user = req.session.user = userData
          res.locals.user = req.user
          next()
        }
      })
    } else {
      req.user = req.session.user = null
      res.locals.user = req.user
      next()
    }
  }
}
