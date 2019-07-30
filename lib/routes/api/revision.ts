import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Revision } = crowi.controllers
  const { AccessTokenParser, LoginRequired } = crowi.middlewares

  router.use('/revisions*', AccessTokenParser, LoginRequired)

  router.get('/revisions.get', Revision.api.get)
  router.get('/revisions.ids', Revision.api.ids)
  router.get('/revisions.list', Revision.api.list)

  return router
}
