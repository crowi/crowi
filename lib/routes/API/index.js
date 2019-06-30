const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const routes = {
    Page: require('./page')(crowi, app, form),
    Admin: require('./admin')(crowi, app, form),
    Share: require('./share')(crowi, app, form),
    Notification: require('./notification')(crowi, app, form),
    Bookmark: require('./bookmark')(crowi, app, form),
    Revision: require('./revision')(crowi, app, form),
  }

  for (const route of Object.values(routes)) {
    router.use(route)
  }

  return router
}
