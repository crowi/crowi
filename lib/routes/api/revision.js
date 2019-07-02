const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Revision } = crowi.controllers
  const { AccessTokenParser, LoginRequired } = crowi.middlewares

  router.use('/revisions*', AccessTokenParser, LoginRequired)

  router.get('/revisions.get', Revision.api.get)
  router.get('/revisions.ids', Revision.api.ids)
  router.get('/revisions.list', Revision.api.list)

  return router
}
