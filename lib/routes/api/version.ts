import { Router, Express } from 'express'
import Crowi from 'server/crowi'
const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const { Version } = crowi.controllers

  router.get('/versions.get', Version.api.get)

  return router
}
