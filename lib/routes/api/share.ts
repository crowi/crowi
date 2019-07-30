import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Share } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.get('/shares.get', AccessTokenParser, LoginRequired, Share.api.get)
  router.get('/shares.list', AccessTokenParser, LoginRequired, Share.api.list)
  router.post('/shares.create', AccessTokenParser, LoginRequired, csrf, Share.api.create)
  router.post('/shares.delete', AccessTokenParser, LoginRequired, csrf, Share.api.delete)
  router.post('/shares/secretKeyword.set', AccessTokenParser, LoginRequired, csrf, Share.api.setSecretKeyword)
  router.post('/shares/secretKeyword.check', csrf, Share.api.checkSecretKeyword)

  return router
}
