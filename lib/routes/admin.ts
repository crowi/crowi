import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Admin } = crowi.controllers
  const { LoginRequired, AdminRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use('/admin*', LoginRequired, AdminRequired)

  router.get('/admin', Admin.index)
  router.get('/admin/app', Admin.index)
  router.get('/admin/notification', Admin.index)
  router.get('/admin/notification/slackAuth', Admin.notification.slackAuth)
  router.get('/admin/users', Admin.index)
  router.get('/admin/search', Admin.index)
  router.get('/admin/share', Admin.index)
  router.get('/admin/backlink', Admin.index)

  return router
}
