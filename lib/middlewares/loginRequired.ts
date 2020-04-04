import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import auth from '../utils/auth'
import Debug from 'debug'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:middlewares:loginRequired')

  return async (req: Request, res: Response, next) => {
    const User = crowi.model('User')
    const config = crowi.getConfig()
    const { originalUrl } = req
    const query = originalUrl === '/' ? '' : `?continue=${originalUrl}`
    const isAuthPage = originalUrl.startsWith('/me/auth/')
    const isAPI = originalUrl.startsWith('/_api/')

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
