const { Router } = require('express')
const router = Router()

module.exports = (crowi, app, form) => {
  const routes = {
    Admin: require('./admin')(crowi, app, form),
    Attachment: require('./attachment')(crowi, app, form),
    Bookmark: require('./bookmark')(crowi, app, form),
    Notification: require('./notification')(crowi, app, form),
    Page: require('./page')(crowi, app, form),
    Revision: require('./revision')(crowi, app, form),
    Share: require('./share')(crowi, app, form),
    Comment: require('./comment')(crowi, app, form),
    Like: require('./like')(crowi, app, form),
  }

  for (const route of Object.values(routes)) {
    router.use(route)
  }

  return router
}
