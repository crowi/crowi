const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const { Version } = crowi.controllers

  router.get('/versions.get', Version.api.get)

  return router
}
