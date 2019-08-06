import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Me } = crowi.controllers
  const { LoginRequired } = crowi.middlewares

  router.use('/me*', LoginRequired)

  router.get('/me', Me.index)
  router.get('/me/password', Me.password)
  router.get('/me/apiToken', Me.apiToken)
  router.get('/me/auth/third-party', Me.authThirdParty)
  router.post('/me', form.me.user, Me.index)
  router.post('/me/password', form.me.password, Me.password)
  router.post('/me/apiToken', form.me.apiToken, Me.apiToken)
  router.get('/me/notifications', Me.notifications)
  router.post('/me/picture/delete', Me.deletePicture)
  router.post('/me/auth/google', Me.authGoogle)
  router.get('/me/auth/google/callback', Me.authGoogleCallback)
  router.post('/me/auth/github', Me.authGitHub)
  router.get('/me/auth/github/callback', Me.authGitHubCallback)

  return router
}
