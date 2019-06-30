const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Notification } = crowi.controllers
  const { LoginRequired, AccessTokenParser } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AccessTokenParser)

  router.get('/notification.list', Notification.api.list)
  router.post('/notification.read', Notification.api.read)
  router.post('/notification.open', Notification.api.open)
  router.get('/notification.status', Notification.api.status)

  return router
}
