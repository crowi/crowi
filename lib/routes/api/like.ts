import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Page } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use('/likes*', AccessTokenParser, LoginRequired)

  router.post('/likes.add', csrf, Page.api.like)
  router.post('/likes.remove', csrf, Page.api.unlike)

  return router
}
