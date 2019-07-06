const basicAuth = require('basic-auth-connect')

const { parseAccessToken } = require('../util/accessTokenParser')

module.exports = (crowi, app) => {
  return (req, res, next) => {
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
