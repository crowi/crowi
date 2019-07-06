const debug = require('debug')('crowi:middlewares:accessTokenParser')

const { parseAccessToken } = require('../util/accessTokenParser')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    const accessToken = parseAccessToken(req)
    if (!accessToken) {
      return next()
    }

    var User = crowi.model('User')

    debug('accessToken is', accessToken)
    User.findUserByApiToken(accessToken)
      .then(function(userData) {
        req.user = userData
        req.skipCsrfVerify = true
        debug('Access token parsed: skipCsrfVerify')

        next()
      })
      .catch(function(err) {
        next()
      })
  }
}
