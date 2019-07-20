module.exports = (crowi, app) => {
  return async (req, res, next) => {
    const User = crowi.model('User')
    const config = crowi.getConfig()
    const { path = '', originalUrl } = req
    const auth = require('../util/auth')
    const query = originalUrl === '/' ? '' : `?continue=${originalUrl}`
    const isAuthPage = path.startsWith('/me/auth/')
    const isAPI = path.startsWith('/_api/')

    if (!isAuthPage && auth.isAccessTokenExpired(req)) {
      const success = await auth.reauth(req, config)
      if (!success) {
        res.redirect('/logout')
      }
    }

    if (req.user && '_id' in req.user) {
      const { 'auth:requireThirdPartyAuth': requireThirdPartyAuth = '' } = config.crowi
      const hasValidThirdPartyId = req.user.hasValidThirdPartyId()
      if (!isAuthPage && !isAPI && requireThirdPartyAuth && !hasValidThirdPartyId) {
        return res.redirect(`/me/auth/third-party${query}`)
      }

      if (req.user.status === User.STATUS_ACTIVE) {
        // Active の人だけ先に進める
        return next()
      } else if (req.user.status === User.STATUS_REGISTERED) {
        return res.redirect('/login/error/registered')
      } else if (req.user.status === User.STATUS_SUSPENDED) {
        return res.redirect('/login/error/suspended')
      } else if (req.user.status === User.STATUS_INVITED) {
        return res.redirect('/login/invited')
      }
    }

    if (isAPI) {
      return res.sendStatus(403)
    }

    return res.redirect(`/login${query}`)
  }
}
