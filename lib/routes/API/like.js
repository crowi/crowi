const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Page } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use(AccessTokenParser)
  router.use(LoginRequired)

  router.post('/likes.add', csrf, Page.api.like)
  router.post('/likes.remove', csrf, Page.api.unlike)

  return router
}
