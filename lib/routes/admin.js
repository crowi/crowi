const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Admin } = crowi.controllers
  const { LoginRequired, AdminRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AdminRequired)

  router.get('/admin', Admin.index)
  router.get('/admin/app', Admin.app.index)

  router.get('/admin/search', Admin.search.index)
  router.post('/admin/search/build', csrf, Admin.search.buildIndex)

  router.get('/admin/notification', Admin.notification.index)
  router.post('/admin/notification/slackSetting', csrf, form.admin.slackSetting, Admin.notification.slackSetting)
  router.get('/admin/notification/slackAuth', Admin.notification.slackAuth)

  router.get('/admin/users', Admin.user.index)
  router.post('/admin/user/invite', form.admin.userInvite, csrf, Admin.user.invite)
  router.post('/admin/user/:id/makeAdmin', csrf, Admin.user.makeAdmin)
  router.post('/admin/user/:id/removeFromAdmin', Admin.user.removeFromAdmin)
  router.post('/admin/user/:id/activate', csrf, Admin.user.activate)
  router.post('/admin/user/:id/suspend', csrf, Admin.user.suspend)
  router.post('/admin/user/:id/remove', csrf, Admin.user.remove)
  router.post('/admin/user/:id/removeCompletely', csrf, Admin.user.removeCompletely)

  router.get('/admin/share', Admin.share.index)

  router.get('/admin/backlink', Admin.backlink.index)
  router.post('/admin/backlink/build', csrf, Admin.backlink.buildBacklinks)

  return router
}
