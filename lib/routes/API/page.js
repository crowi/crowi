const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Page } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)

  router.get('/pages.list', AccessTokenParser, Page.api.list)
  router.post('/pages.create', AccessTokenParser, csrf, Page.api.create)
  router.post('/pages.update', AccessTokenParser, csrf, Page.api.update)
  router.get('/pages.get', AccessTokenParser, Page.api.get)
  router.get('/pages.updatePost', AccessTokenParser, Page.api.getUpdatePost)
  router.post('/pages.seen', AccessTokenParser, Page.api.seen)
  router.post('/pages.rename', AccessTokenParser, csrf, Page.api.rename)
  router.post('/pages.renameTree', AccessTokenParser, csrf, Page.api.renameTree)
  router.post('/pages.checkTreeRenamable', AccessTokenParser, Page.api.checkTreeRenamable)
  router.post('/pages.remove', csrf, Page.api.remove) // (Avoid from API Token)
  router.post('/pages.revertRemove', csrf, Page.api.revertRemove) // (Avoid from API Token)
  router.post('/pages.unlink', csrf, Page.api.unlink) // (Avoid from API Token)
  router.get('/pages.watch.status', AccessTokenParser, Page.api.watchStatus)
  router.post('/pages.watch', AccessTokenParser, Page.api.watch)

  return router
}
