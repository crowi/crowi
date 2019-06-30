const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Comment } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use(AccessTokenParser)
  router.use(LoginRequired)

  router.get('/comments.get', Comment.api.get)
  router.post('/comments.add', form.comment, csrf, Comment.api.add)

  return router
}
