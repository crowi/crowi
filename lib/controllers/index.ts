import { Express } from 'express'
import Crowi from 'server/crowi'

import Admin from './admin'
import Attachment from './attachment'
import Backlink from './backlink'
import Bookmark from './bookmark'
import Comment from './comment'
import Installer from './installer'
import Login from './login'
import Logout from './logout'
import Me from './me'
import Notification from './notification'
import Page from './page'
import Revision from './revision'
import Search from './search'
import Share from './share'
import ShareAccess from './shareAccess'
import Slack from './slack'
import User from './user'
import Version from './version'

export default (crowi: Crowi, app: Express) => ({
  Admin: Admin(crowi),
  Attachment: Attachment(crowi, app),
  Backlink: Backlink(crowi),
  Bookmark: Bookmark(crowi),
  Comment: Comment(crowi),
  Installer: Installer(crowi),
  Login: Login(crowi, app),
  Logout: Logout(),
  Me: Me(crowi, app),
  Notification: Notification(crowi),
  Page: Page(crowi),
  Revision: Revision(crowi),
  Search: Search(crowi),
  Share: Share(crowi),
  ShareAccess: ShareAccess(crowi),
  Slack: Slack(crowi),
  User: User(crowi),
  Version: Version(crowi, app),
})
