const debug = require('debug')('crowi:middlewares:accessTokenParser')

/**
 * Extract Bearer token from Authorization header.
 *
 * @param {Object} headers HTTP request headers
 * @param {string} headers.authorization Authorization header value.
 * @return {?string} found access_token or null.
 */
const extractBearerToken = headers => {
  const v = headers.authorization
  if (!v) {
    return null
  }

  const parts = v
    .trim()
    .replace(/( )+/g, ' ')
    .split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null
  }

  return parts[1]
}

module.exports = (crowi, app) => {
  return (req, res, next) => {
    var accessToken = extractBearerToken(req.headers) || req.query.access_token || req.body.access_token || null
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
