const debug = require('debug')('crowi:middlewares:csrfVerify')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    var token = req.body._csrf || req.query._csrf || null
    var csrfKey = (req.session && req.session.id) || 'anon'

    debug('req.skipCsrfVerify', req.skipCsrfVerify)
    if (req.skipCsrfVerify) {
      debug('csrf verify skipped')
      return next()
    }

    if (crowi.getTokens().verify(csrfKey, token)) {
      return next()
    }

    debug('csrf verification failed. return 403', csrfKey, token)
    return res.sendStatus(403)
  }
}
