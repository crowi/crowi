import Crowi from 'server/crowi'
import Debug from 'debug'

const debug = Debug('crowi:middlewares:csrfVerify')

export default (crowi: Crowi) => {
  return (req, res, next) => {
    const token = req.body._csrf || req.query._csrf || null
    const csrfKey = (req.session && req.session.id) || 'anon'

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
