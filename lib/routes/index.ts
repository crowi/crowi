import { Express } from 'express'
import Crowi from 'server/crowi'

import multer from 'multer'

import form from '../form'

import Admin from './admin'
import API from './api'
import Login from './login'
import Me from './me'

export default (crowi: Crowi, app: Express) => {
  const controllers = crowi.controllers
  const middlewares = crowi.middlewares

  const routes = {
    Admin: Admin(crowi, app, form),
    API: API(crowi, app, form),
    Login: Login(crowi, app, form),
    Me: Me(crowi, app, form),
  }

  const uploads = multer({ dest: crowi.tmpDir + 'uploads' })

  const {
    Page: page,
    Login: login,
    Logout: logout,
    Me: me,
    Installer: installer,
    User: user,
    Attachment: attachment,
    Search: search,
    Share: share,
    ShareAccess: shareAccess,
    Notification: notification,
    Backlink: backlink,
    Slack: slack,
  } = controllers

  const {
    LoginRequired: loginRequired,
    FileAccessRightOrLoginRequired: fileAccessRightOrLoginRequired,
    EncodeSpace: encodeSpace,
    AccessTokenParser: accessTokenParser,
    CsrfVerify: csrf,
    ApplicationNotInstalled: applicationNotInstalled,
    ApplicationInstalled: applicationInstalled,
  } = middlewares

  app.use(routes.Admin)
  app.use(routes.Login)
  app.use(routes.Me)
  app.use('/_api', routes.API)

  app.get('/', loginRequired, page.pageListShow)

  app.get('/installer', applicationNotInstalled, installer.index)
  app.post('/installer/createAdmin', applicationNotInstalled, form.register, csrf, installer.createAdmin)

  app.post('/register', form.register, csrf, login.register)
  app.get('/register', applicationInstalled, login.register)
  app.get('/google/callback', login.googleCallback)
  app.get('/github/callback', login.githubCallback)
  app.get('/logout', logout.logout)

  app.get('/:id([0-9a-z]{24})', loginRequired, page.api.redirector)
  app.get('/_r/:id([0-9a-z]{24})', loginRequired, page.api.redirector) // alias
  app.get('/files/:id([0-9a-z]{24})', fileAccessRightOrLoginRequired, attachment.api.redirector)

  app.get('/_search', loginRequired, search.searchPage)
  app.get('/_api/search', accessTokenParser, loginRequired, search.api.search)

  app.get('/_share/:uuid([0-9a-z-]{36})', share.pageShow)

  app.get('/user/:username([^/]+)/bookmarks', loginRequired, page.userBookmarkList)
  app.get('/user/:username([^/]+)/recent-create', loginRequired, page.userRecentCreatedList)

  // HTTP RPC Styled API (に徐々に移行していいこうと思う)
  app.get('/_api/backlink.list', accessTokenParser, loginRequired, backlink.api.list)
  app.get('/_api/check_username', user.api.checkUsername)
  app.get('/_api/shares/accesses.list', accessTokenParser, loginRequired, shareAccess.api.list)
  app.get('/_api/user/recentlyViewed', loginRequired, user.api.getRecentlyViewedPages)
  app.get('/_api/users.list', accessTokenParser, loginRequired, user.api.list)
  app.post('/_api/me/picture/upload', loginRequired, uploads.single('userPicture'), me.api.uploadPicture)
  app.post('/_api/slack/event', slack.api.handleEvent)

  app.post('/_/edit', form.revision, loginRequired, csrf, page.pageEdit)
  app.get('/trash/$', loginRequired, page.deletedPageListShow)
  app.get('/trash/*/$', loginRequired, page.deletedPageListShow)
  app.get('/*/$', loginRequired, encodeSpace, page.pageListShow)
  app.get('/user/:username([^/]+)', loginRequired, page.userPageShow)
  app.get('/*', loginRequired, encodeSpace, page.pageShow)
}
