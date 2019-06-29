// const debug = require('debug')('crowi:middlewares:loginChecker')

module.exports = (crowi, app) => {
  return function(req, res, next) {
    var User = crowi.model('User')
    var csrfKey = (req.session && req.session.id) || 'anon'

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
