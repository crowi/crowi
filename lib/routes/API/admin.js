const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Admin } = crowi.controllers
  const { LoginRequired, AdminRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AdminRequired)

  router.post('/admin/settings/app', csrf, form.admin.app, Admin.api.appSetting)
  router.post('/admin/settings/sec', form.admin.sec, Admin.api.appSetting)
  router.post('/admin/settings/auth', form.admin.auth, Admin.api.appSetting)
  router.post('/admin/settings/mail', csrf, form.admin.mail, Admin.api.appSetting)
  router.post('/admin/settings/aws', csrf, form.admin.aws, Admin.api.appSetting)
  router.post('/admin/settings/google', csrf, form.admin.google, Admin.api.appSetting)
  router.post('/admin/settings/github', csrf, form.admin.github, Admin.api.appSetting)
  router.post('/admin/settings/share', csrf, form.admin.share, Admin.api.appSetting)

  router.post('/admin/notification.add', csrf, Admin.api.notificationAdd)
  router.post('/admin/notification.remove', csrf, Admin.api.notificationRemove)
  router.get('/admin/users.search', Admin.api.usersSearch)

  // new route patterns from here:
  router.post('/admin/users.resetPassword', csrf, Admin.user.resetPassword)
  router.post('/admin/users.updateEmail', csrf, Admin.user.updateEmail)

  return router
}
