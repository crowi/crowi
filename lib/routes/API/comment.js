const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Comment } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AccessTokenParser)

  router.get('/comments.get', Comment.api.get)
  router.post('/comments.add', form.comment, csrf, Comment.api.add)

  return router
}
