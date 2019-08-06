import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Notification } = crowi.controllers
  const { AccessTokenParser, LoginRequired } = crowi.middlewares

  router.use('/notification*', AccessTokenParser, LoginRequired)

  router.get('/notification.list', Notification.api.list)
  router.post('/notification.read', Notification.api.read)
  router.post('/notification.open', Notification.api.open)
  router.get('/notification.status', Notification.api.status)

  return router
}
