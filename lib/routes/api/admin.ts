import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Admin } = crowi.controllers
  const { LoginRequired, AdminRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use('/admin*', LoginRequired, AdminRequired)

  router.get('/admin', Admin.api.index)

  router.get('/admin/top', Admin.api.top.index)

  router.get('/admin/app', Admin.api.app.index)
  router.post('/admin/settings/app', csrf, form.admin.app, Admin.api.postSettings)
  router.post('/admin/settings/sec', csrf, form.admin.sec, Admin.api.postSettings)
  router.post('/admin/settings/auth', csrf, form.admin.auth, Admin.api.postSettings)
  router.post('/admin/settings/mail', csrf, form.admin.mail, Admin.api.postSettings)
  router.post('/admin/settings/aws', csrf, form.admin.aws, Admin.api.postSettings)
  router.post('/admin/settings/google', csrf, form.admin.google, Admin.api.postSettings)
  router.post('/admin/settings/github', csrf, form.admin.github, Admin.api.postSettings)
  router.post('/admin/settings/share', csrf, form.admin.share, Admin.api.postSettings)

  router.post('/admin/search/build', csrf, Admin.api.search.buildIndex)

  router.get('/admin/notification', Admin.api.notification.index)
  router.post('/admin/notification/slackSetting', csrf, form.admin.slackSetting, Admin.api.notification.slackSetting)
  router.post('/admin/notification.add', csrf, Admin.api.notificationAdd)
  router.post('/admin/notification.remove', csrf, Admin.api.notificationRemove)

  router.get('/admin/users', Admin.api.user.index)
  router.get('/admin/users.search', Admin.api.usersSearch)
  router.post('/admin/user/invite', csrf, form.admin.userInvite, Admin.api.user.invite)
  router.post('/admin/user/:id/makeAdmin', csrf, Admin.api.user.makeAdmin)
  router.post('/admin/user/:id/removeFromAdmin', Admin.api.user.removeFromAdmin)
  router.post('/admin/user/:id/activate', csrf, Admin.api.user.activate)
  router.post('/admin/user/:id/suspend', csrf, Admin.api.user.suspend)
  router.post('/admin/users.resetPassword', csrf, Admin.api.user.resetPassword)
  router.post('/admin/users.updateEmail', csrf, Admin.api.user.updateEmail)

  router.post('/admin/backlink/build', csrf, Admin.api.backlink.buildBacklinks)

  return router
}
