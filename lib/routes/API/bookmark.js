const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Bookmark } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AccessTokenParser)

  app.get('/bookmarks.list', Bookmark.api.list)
  app.get('/bookmarks.get', Bookmark.api.get)
  app.post('/bookmarks.add', csrf, Bookmark.api.add)
  app.post('/bookmarks.remove', csrf, Bookmark.api.remove)

  return router
}
