module.exports = function(crowi, app) {
  const controllers = crowi.controllers
  const middlewares = crowi.middlewares
  const form = require('../form')

  const routes = {
    Me: require('./me')(crowi, app, form),
    Login: require('./login')(crowi, app, form),
    Admin: require('./admin')(crowi, app, form),
    API: require('./API')(crowi, app, form),
  }

  var multer = require('multer')
  var uploads = multer({ dest: crowi.tmpDir + 'uploads' })
  var page = controllers.Page
  var login = controllers.Login
  var logout = controllers.Logout
  var me = controllers.Me
  var installer = controllers.Installer
  var user = controllers.User
  var attachment = controllers.Attachment
  var comment = controllers.Comment
  var bookmark = controllers.Bookmark
  var revision = controllers.Revision
  var search = controllers.Search
  var share = controllers.Share
  var shareAccess = controllers.ShareAccess
  var notification = controllers.Notification
  var backlink = controllers.Backlink
  var slack = controllers.Slack
  var loginRequired = middlewares.LoginRequired
  var fileAccessRightOrLoginRequired = middlewares.FileAccessRightOrLoginRequired
  var encodeSpace = middlewares.EncodeSpace
  var accessTokenParser = middlewares.AccessTokenParser
  var csrf = middlewares.CsrfVerify
  var applicationNotInstalled = middlewares.ApplicationNotInstalled
  var applicationInstalled = middlewares.ApplicationInstalled

  app.use(routes.Me)
  app.use(routes.Login)
  app.use(routes.Admin)
  app.use('/_api', routes.API)

  app.get('/', loginRequired, page.pageListShow)

  app.get('/installer', applicationNotInstalled, installer.index)
  app.post('/installer/createAdmin', applicationNotInstalled, form.register, csrf, installer.createAdmin)
  // app.post('/installer/user'         , applicationNotInstalled , installer.createFirstUser);

  app.post('/register', form.register, csrf, login.register)
  app.get('/register', applicationInstalled, login.register)
  app.get('/google/callback', login.googleCallback)
  app.get('/github/callback', login.githubCallback)
  app.get('/logout', logout.logout)

  app.get('/:id([0-9a-z]{24})', loginRequired, page.api.redirector)
  app.get('/_r/:id([0-9a-z]{24})', loginRequired, page.api.redirector) // alias
  app.get('/files/:id([0-9a-z]{24})', fileAccessRightOrLoginRequired, attachment.api.redirector)

  app.get('/_notifications', accessTokenParser, loginRequired, notification.notificationPage)

  app.get('/_search', loginRequired, search.searchPage)
  app.get('/_api/search', accessTokenParser, loginRequired, search.api.search)

  app.get('/_share/:uuid([0-9a-z-]{36})', share.pageShow)

  app.get('/_api/check_username', user.api.checkUsername)
  app.post('/_api/me/picture/upload', loginRequired, uploads.single('userPicture'), me.api.uploadPicture)
  app.get('/_api/user/bookmarks', loginRequired, user.api.bookmarks)
  app.get('/_api/user/recentlyViewed', loginRequired, user.api.getRecentlyViewedPages)

  app.get('/user/:username([^/]+)/bookmarks', loginRequired, page.userBookmarkList)
  app.get('/user/:username([^/]+)/recent-create', loginRequired, page.userRecentCreatedList)

  // HTTP RPC Styled API (に徐々に移行していいこうと思う)
  app.get('/_api/users.list', accessTokenParser, loginRequired, user.api.list)
  app.get('/_api/comments.get', accessTokenParser, loginRequired, comment.api.get)
  app.post('/_api/comments.add', form.comment, accessTokenParser, loginRequired, csrf, comment.api.add)
  app.get('/_api/bookmarks.list', accessTokenParser, loginRequired, bookmark.api.list)
  app.get('/_api/bookmarks.get', accessTokenParser, loginRequired, bookmark.api.get)
  app.post('/_api/bookmarks.add', accessTokenParser, loginRequired, csrf, bookmark.api.add)
  app.post('/_api/bookmarks.remove', accessTokenParser, loginRequired, csrf, bookmark.api.remove)
  app.post('/_api/likes.add', accessTokenParser, loginRequired, csrf, page.api.like)
  app.post('/_api/likes.remove', accessTokenParser, loginRequired, csrf, page.api.unlike)
  app.get('/_api/attachments.list', accessTokenParser, loginRequired, attachment.api.list)
  app.post('/_api/attachments.add', uploads.single('file'), accessTokenParser, loginRequired, csrf, attachment.api.add)
  app.post('/_api/attachments.remove', accessTokenParser, loginRequired, csrf, attachment.api.remove)

  app.get('/_api/revisions.get', accessTokenParser, loginRequired, revision.api.get)
  app.get('/_api/revisions.ids', accessTokenParser, loginRequired, revision.api.ids)
  app.get('/_api/revisions.list', accessTokenParser, loginRequired, revision.api.list)

  app.get('/_api/backlink.list', accessTokenParser, loginRequired, backlink.api.list)

  // app.get('/_api/revision/:id'     , user.useUserData()         , revision.api.get);
  // app.get('/_api/r/:revisionId'    , user.useUserData()         , page.api.get);

  app.get('/_api/shares/accesses.list', accessTokenParser, loginRequired, shareAccess.api.list)

  app.post('/_api/slack/event', slack.api.handleEvent)

  app.post('/_/edit', form.revision, loginRequired, csrf, page.pageEdit)
  app.get('/trash/$', loginRequired, page.deletedPageListShow)
  app.get('/trash/*/$', loginRequired, page.deletedPageListShow)
  app.get('/*/$', loginRequired, encodeSpace, page.pageListShow)
  app.get('/user/:username([^/]+)', loginRequired, page.userPageShow)
  app.get('/*', loginRequired, encodeSpace, page.pageShow)
}
