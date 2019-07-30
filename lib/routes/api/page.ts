import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Page } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.get('/pages.list', AccessTokenParser, LoginRequired, Page.api.list)
  router.post('/pages.create', AccessTokenParser, LoginRequired, csrf, Page.api.create)
  router.post('/pages.update', AccessTokenParser, LoginRequired, csrf, Page.api.update)
  router.get('/pages.get', AccessTokenParser, LoginRequired, Page.api.get)
  router.get('/pages.updatePost', AccessTokenParser, LoginRequired, Page.api.getUpdatePost)
  router.post('/pages.seen', AccessTokenParser, LoginRequired, Page.api.seen)
  router.post('/pages.rename', AccessTokenParser, LoginRequired, csrf, Page.api.rename)
  router.post('/pages.renameTree', AccessTokenParser, LoginRequired, csrf, Page.api.renameTree)
  router.post('/pages.checkTreeRenamable', AccessTokenParser, LoginRequired, Page.api.checkTreeRenamable)
  router.post('/pages.remove', LoginRequired, csrf, Page.api.remove) // (Avoid from API Token)
  router.post('/pages.revertRemove', LoginRequired, csrf, Page.api.revertRemove) // (Avoid from API Token)
  router.post('/pages.unlink', LoginRequired, csrf, Page.api.unlink) // (Avoid from API Token)
  router.get('/pages.watch.status', AccessTokenParser, LoginRequired, Page.api.watchStatus)
  router.post('/pages.watch', AccessTokenParser, LoginRequired, Page.api.watch)

  return router
}
