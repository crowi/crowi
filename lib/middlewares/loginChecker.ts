import { Express } from 'express'
import Crowi from 'server/crowi'
// const debug = Debug('crowi:middlewares:loginChecker')

export default (crowi: Crowi, app: Express) => {
  return (req, res, next) => {
    const User = crowi.model('User')
    const csrfKey = (req.session && req.session.id) || 'anon'

    if (req.csrfToken === null) {
      req.csrfToken = crowi.getTokens().create(csrfKey)
    }

    // session に user object が入ってる
    if (req.session.user && '_id' in req.session.user) {
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
      req.user = req.session.user = false
      res.locals.user = req.user
      next()
    }
  }
}
