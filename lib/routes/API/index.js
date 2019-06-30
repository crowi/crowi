const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const routes = {
    Page: require('./page')(crowi, app, form),
    Admin: require('./admin')(crowi, app, form),
  }

  router.use(routes.Page)

  return router
}
