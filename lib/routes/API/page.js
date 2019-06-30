const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Page } = crowi.controllers
  const { LoginRequired, AccessTokenParser, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)

  router.get('/_api/pages.list', AccessTokenParser, Page.api.list)
  router.post('/_api/pages.create', AccessTokenParser, csrf, Page.api.create)
  router.post('/_api/pages.update', AccessTokenParser, csrf, Page.api.update)
  router.get('/_api/pages.get', AccessTokenParser, Page.api.get)
  router.get('/_api/pages.updatePost', AccessTokenParser, Page.api.getUpdatePost)
  router.post('/_api/pages.seen', AccessTokenParser, Page.api.seen)
  router.post('/_api/pages.rename', AccessTokenParser, csrf, Page.api.rename)
  router.post('/_api/pages.renameTree', AccessTokenParser, csrf, Page.api.renameTree)
  router.post('/_api/pages.checkTreeRenamable', AccessTokenParser, Page.api.checkTreeRenamable)
  router.post('/_api/pages.remove', csrf, Page.api.remove) // (Avoid from API Token)
  router.post('/_api/pages.revertRemove', csrf, Page.api.revertRemove) // (Avoid from API Token)
  router.post('/_api/pages.unlink', csrf, Page.api.unlink) // (Avoid from API Token)
  router.get('/_api/pages.watch.status', AccessTokenParser, Page.api.watchStatus)
  router.post('/_api/pages.watch', AccessTokenParser, Page.api.watch)

  return router
}
