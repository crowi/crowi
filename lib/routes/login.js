const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Login } = crowi.controllers
  const { ApplicationInstalled, CsrfVerify: csrf } = crowi.middlewares

  router.get('/login/error/:reason', Login.error)
  router.get('/login', ApplicationInstalled, Login.login)
  router.get('/login/invited', Login.invited)
  router.post('/login/activateInvited', form.invited, csrf, Login.invited)
  router.post('/login', form.login, csrf, Login.login)
  router.get('/login/google', Login.loginGoogle)
  router.get('/login/github', Login.loginGitHub)

  return router
}
