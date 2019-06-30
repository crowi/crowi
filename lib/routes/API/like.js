const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Page } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AccessTokenParser)

  router.post('/likes.add', csrf, Page.api.like)
  router.post('/likes.remove', csrf, Page.api.unlike)

  return router
}
