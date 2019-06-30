const basicAuth = require('basic-auth-connect')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    var config = crowi.getConfig()
    if (req.query.access_token || req.body.access_token) {
      return next()
    }

    if (config.crowi['security:basicName'] && config.crowi['security:basicSecret']) {
      return basicAuth(config.crowi['security:basicName'], config.crowi['security:basicSecret'])(req, res, next)
    } else {
      next()
    }
  }
}
