import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Comment } = crowi.controllers
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares

  router.use('/comments*', AccessTokenParser, LoginRequired)

  router.get('/comments.get', Comment.api.get)
  router.post('/comments.add', form.comment, csrf, Comment.api.add)

  return router
}
