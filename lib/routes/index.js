module.exports = function(crowi, app) {
  const controllers = crowi.controllers
  const middlewares = crowi.middlewares
  const form = require('../form')

  const routes = {
    Me: require('./me')(crowi, app, form),
  }

  var multer = require('multer')
  var uploads = multer({ dest: crowi.tmpDir + 'uploads' })
  var page = controllers.Page
  var login = controllers.Login
  var logout = controllers.Logout
  var me = controllers.Me
  var admin = controllers.Admin
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
  var adminRequired = middlewares.AdminRequired
  var fileAccessRightOrLoginRequired = middlewares.FileAccessRightOrLoginRequired
  var encodeSpace = middlewares.EncodeSpace
  var accessTokenParser = middlewares.AccessTokenParser
  var csrf = middlewares.CsrfVerify
  var applicationNotInstalled = middlewares.ApplicationNotInstalled
  var applicationInstalled = middlewares.ApplicationInstalled

  app.use(routes.Me)
  app.get('/', loginRequired, page.pageListShow)

  app.get('/installer', applicationNotInstalled, installer.index)
  app.post('/installer/createAdmin', applicationNotInstalled, form.register, csrf, installer.createAdmin)
  // app.post('/installer/user'         , applicationNotInstalled , installer.createFirstUser);

  app.get('/login/error/:reason', login.error)
  app.get('/login', applicationInstalled, login.login)
  app.get('/login/invited', login.invited)
  app.post('/login/activateInvited', form.invited, csrf, login.invited)
  app.post('/login', form.login, csrf, login.login)
  app.post('/register', form.register, csrf, login.register)
  app.get('/register', applicationInstalled, login.register)
  app.get('/google/callback', login.googleCallback)
  app.get('/github/callback', login.githubCallback)
  app.get('/login/google', login.loginGoogle)
  app.get('/login/github', login.loginGitHub)
  app.get('/logout', logout.logout)

  app.get('/admin', loginRequired, adminRequired, admin.index)
  app.get('/admin/app', loginRequired, adminRequired, admin.app.index)
  app.post('/_api/admin/settings/app', loginRequired, adminRequired, csrf, form.admin.app, admin.api.appSetting)
  app.post('/_api/admin/settings/sec', loginRequired, adminRequired, form.admin.sec, admin.api.appSetting)
  app.post('/_api/admin/settings/auth', loginRequired, adminRequired, form.admin.auth, admin.api.appSetting)
  app.post('/_api/admin/settings/mail', loginRequired, adminRequired, csrf, form.admin.mail, admin.api.appSetting)
  app.post('/_api/admin/settings/aws', loginRequired, adminRequired, csrf, form.admin.aws, admin.api.appSetting)
  app.post('/_api/admin/settings/google', loginRequired, adminRequired, csrf, form.admin.google, admin.api.appSetting)
  app.post('/_api/admin/settings/github', loginRequired, adminRequired, csrf, form.admin.github, admin.api.appSetting)
  app.post('/_api/admin/settings/share', loginRequired, adminRequired, csrf, form.admin.share, admin.api.appSetting)

  // search admin
  app.get('/admin/search', loginRequired, adminRequired, admin.search.index)
  app.post('/admin/search/build', loginRequired, adminRequired, csrf, admin.search.buildIndex)

  // notification admin
  app.get('/admin/notification', loginRequired, adminRequired, admin.notification.index)
  app.post('/admin/notification/slackSetting', loginRequired, adminRequired, csrf, form.admin.slackSetting, admin.notification.slackSetting)
  app.get('/admin/notification/slackAuth', loginRequired, adminRequired, admin.notification.slackAuth)
  app.post('/_api/admin/notification.add', loginRequired, adminRequired, csrf, admin.api.notificationAdd)
  app.post('/_api/admin/notification.remove', loginRequired, adminRequired, csrf, admin.api.notificationRemove)
  app.get('/_api/admin/users.search', loginRequired, adminRequired, admin.api.usersSearch)

  app.get('/admin/users', loginRequired, adminRequired, admin.user.index)
  app.post('/admin/user/invite', form.admin.userInvite, loginRequired, adminRequired, csrf, admin.user.invite)
  app.post('/admin/user/:id/makeAdmin', loginRequired, adminRequired, csrf, admin.user.makeAdmin)
  app.post('/admin/user/:id/removeFromAdmin', loginRequired, adminRequired, admin.user.removeFromAdmin)
  app.post('/admin/user/:id/activate', loginRequired, adminRequired, csrf, admin.user.activate)
  app.post('/admin/user/:id/suspend', loginRequired, adminRequired, csrf, admin.user.suspend)
  app.post('/admin/user/:id/remove', loginRequired, adminRequired, csrf, admin.user.remove)
  app.post('/admin/user/:id/removeCompletely', loginRequired, adminRequired, csrf, admin.user.removeCompletely)
  // new route patterns from here:
  app.post('/_api/admin/users.resetPassword', loginRequired, adminRequired, csrf, admin.user.resetPassword)
  app.post('/_api/admin/users.updateEmail', loginRequired, adminRequired, csrf, admin.user.updateEmail)

  app.get('/admin/share', loginRequired, adminRequired, admin.share.index)

  app.get('/admin/backlink', loginRequired, adminRequired, admin.backlink.index)
  app.post('/admin/backlink/build', loginRequired, adminRequired, csrf, admin.backlink.buildBacklinks)

  app.get('/:id([0-9a-z]{24})', loginRequired, page.api.redirector)
  app.get('/_r/:id([0-9a-z]{24})', loginRequired, page.api.redirector) // alias
  app.get('/files/:id([0-9a-z]{24})', fileAccessRightOrLoginRequired, attachment.api.redirector)

  app.get('/_notifications', accessTokenParser, loginRequired, notification.notificationPage)
  app.get('/_api/notification.list', accessTokenParser, loginRequired, notification.api.list)
  app.post('/_api/notification.read', accessTokenParser, loginRequired, notification.api.read)
  app.post('/_api/notification.open', accessTokenParser, loginRequired, notification.api.open)
  app.get('/_api/notification.status', accessTokenParser, loginRequired, notification.api.status)

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
  app.get('/_api/pages.list', accessTokenParser, loginRequired, page.api.list)
  app.post('/_api/pages.create', accessTokenParser, loginRequired, csrf, page.api.create)
  app.post('/_api/pages.update', accessTokenParser, loginRequired, csrf, page.api.update)
  app.get('/_api/pages.get', accessTokenParser, loginRequired, page.api.get)
  app.get('/_api/pages.updatePost', accessTokenParser, loginRequired, page.api.getUpdatePost)
  app.post('/_api/pages.seen', accessTokenParser, loginRequired, page.api.seen)
  app.post('/_api/pages.rename', accessTokenParser, loginRequired, csrf, page.api.rename)
  app.post('/_api/pages.renameTree', accessTokenParser, loginRequired, csrf, page.api.renameTree)
  app.post('/_api/pages.checkTreeRenamable', accessTokenParser, loginRequired, page.api.checkTreeRenamable)
  app.post('/_api/pages.remove', loginRequired, csrf, page.api.remove) // (Avoid from API Token)
  app.post('/_api/pages.revertRemove', loginRequired, csrf, page.api.revertRemove) // (Avoid from API Token)
  app.post('/_api/pages.unlink', loginRequired, csrf, page.api.unlink) // (Avoid from API Token)
  app.get('/_api/pages.watch.status', accessTokenParser, loginRequired, page.api.watchStatus)
  app.post('/_api/pages.watch', accessTokenParser, loginRequired, page.api.watch)
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

  app.get('/_api/shares.get', accessTokenParser, loginRequired, share.api.get)
  app.get('/_api/shares.list', accessTokenParser, loginRequired, share.api.list)
  app.post('/_api/shares.create', accessTokenParser, loginRequired, csrf, share.api.create)
  app.post('/_api/shares.delete', accessTokenParser, loginRequired, csrf, share.api.delete)
  app.post('/_api/shares/secretKeyword.set', accessTokenParser, loginRequired, csrf, share.api.setSecretKeyword)
  app.post('/_api/shares/secretKeyword.check', csrf, share.api.checkSecretKeyword)

  app.get('/_api/shares/accesses.list', accessTokenParser, loginRequired, shareAccess.api.list)

  app.post('/_api/slack/event', slack.api.handleEvent)

  app.post('/_/edit', form.revision, loginRequired, csrf, page.pageEdit)
  app.get('/trash/$', loginRequired, page.deletedPageListShow)
  app.get('/trash/*/$', loginRequired, page.deletedPageListShow)
  app.get('/*/$', loginRequired, encodeSpace, page.pageListShow)
  app.get('/user/:username([^/]+)', loginRequired, page.userPageShow)
  app.get('/*', loginRequired, encodeSpace, page.pageShow)
}
