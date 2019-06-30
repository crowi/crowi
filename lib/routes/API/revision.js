const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Revision } = crowi.controllers
  const { LoginRequired, AccessTokenParser } = crowi.middlewares

  router.use(LoginRequired)
  router.use(AccessTokenParser)

  app.get('/revisions.get', Revision.api.get)
  app.get('/revisions.ids', Revision.api.ids)
  app.get('/revisions.list', Revision.api.list)

  return router
}
