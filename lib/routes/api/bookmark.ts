import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Bookmark } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use('/bookmarks*', AccessTokenParser, LoginRequired)

  router.get('/bookmarks.list', Bookmark.api.list)
  router.get('/bookmarks.get', Bookmark.api.get)
  router.post('/bookmarks.add', csrf, Bookmark.api.add)
  router.post('/bookmarks.remove', csrf, Bookmark.api.remove)

  return router
}
