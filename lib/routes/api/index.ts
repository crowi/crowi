import { Router, Express } from 'express'
import Crowi from 'server/crowi'

import Admin from './admin'
import Attachment from './attachment'
import Bookmark from './bookmark'
import Comment from './comment'
import Like from './like'
import Notification from './notification'
import Page from './page'
import Revision from './revision'
import Share from './share'
import Version from './version'

const router = Router()

export default (crowi: Crowi, app: Express, form) => {
  const routes = {
    Admin: Admin(crowi, app, form),
    Attachment: Attachment(crowi, app, form),
    Bookmark: Bookmark(crowi, app, form),
    Comment: Comment(crowi, app, form),
    Like: Like(crowi, app, form),
    Notification: Notification(crowi, app, form),
    Page: Page(crowi, app, form),
    Revision: Revision(crowi, app, form),
    Share: Share(crowi, app, form),
    Version: Version(crowi, app, form),
  }

  for (const route of Object.values(routes)) {
    router.use(route)
  }

  return router
}
