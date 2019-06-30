const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Bookmark } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use('/bookmarks*', AccessTokenParser, LoginRequired)

  router.get('/bookmarks.list', Bookmark.api.list)
  router.get('/bookmarks.get', Bookmark.api.get)
  router.post('/bookmarks.add', csrf, Bookmark.api.add)
  router.post('/bookmarks.remove', csrf, Bookmark.api.remove)

  return router
}
