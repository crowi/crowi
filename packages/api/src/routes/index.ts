import { getRequestListener } from '@hono/node-server';
import { Express, NextFunction, Request, Response } from 'express';
import Crowi from 'src/crowi';

import multer from 'multer';

import { buildHonoApp } from '../hono';
import form from '../form';

import Admin from './admin';
import API from './api';
import Login from './login';
import Me from './me';
import TsRestRoutes from './ts-rest';

export default (crowi: Crowi, app: Express) => {
  const controllers = crowi.controllers;
  const middlewares = crowi.middlewares;

  const routes = {
    Admin: Admin(crowi, app, form),
    API: API(crowi, app, form),
    Login: Login(crowi, app, form),
    Me: Me(crowi, app, form),
  };

  const uploads = multer({ dest: crowi.tmpDir + 'uploads' });

  const {
    Page: page,
    Login: login,
    Logout: logout,
    Me: me,
    Installer: installer,
    User: user,
    Search: search,
    Share: share,
    ShareAccess: shareAccess,
    Notification: notification,
    Backlink: backlink,
    Slack: slack,
  } = controllers;

  const {
    LoginRequired: loginRequired,
    FileAccessRightOrLoginRequired: fileAccessRightOrLoginRequired,
    EncodeSpace: encodeSpace,
    AccessTokenParser: accessTokenParser,
    CsrfVerify: csrf,
    ApplicationNotInstalled: applicationNotInstalled,
    ApplicationInstalled: applicationInstalled,
  } = middlewares;

  // Mount ts-rest routes (new system)
  TsRestRoutes(crowi, app);

  // RFC-0006 Phase 2 — Hono mount.
  //
  // Build the Hono app once at boot and bridge it into Express as a
  // terminal `/api/v2/*` handler via `@hono/node-server`'s
  // `getRequestListener(fetch)` (which returns a Node-native
  // `(IncomingMessage, ServerResponse) => Promise` — directly usable as
  // an Express handler). Hono is registered AFTER ts-rest so any path
  // already owned by an existing ts-rest router is served by ts-rest
  // before reaching Hono. Hono returns 404 for unknown paths (Phase 2
  // has zero Hono routes), which the client treats identically to the
  // existing ts-rest "no match" behaviour. As Phase 3-4 commits migrate
  // resources, the ts-rest sub-router for that resource is removed and
  // the path falls through to Hono.
  //
  // Phase 6 cleanup deletes the Express host entirely and replaces this
  // with `serve({ fetch: honoApp.fetch, createServer: http.createServer })`
  // (see `.feature-state/specs/feature-hono-integration.md`).
  const honoApp = buildHonoApp(crowi);
  const honoListener = getRequestListener(honoApp.fetch);
  app.use('/api/v2', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await honoListener(req, res);
    } catch (err) {
      next(err);
    }
  });

  app.use(routes.Admin);
  app.use(routes.Login);
  app.use(routes.Me);
  app.use('/_api', routes.API);

  app.get('/', loginRequired, page.pageListShow);

  app.get('/installer', applicationNotInstalled, installer.index);
  app.post('/installer/createAdmin', applicationNotInstalled, form.register, csrf, installer.createAdmin);

  app.post('/register', form.register, csrf, login.register);
  app.get('/register', applicationInstalled, login.register);
  app.get('/google/callback', login.googleCallback);
  app.get('/github/callback', login.githubCallback);
  app.get('/logout', logout.logout);

  app.get('/:id([0-9a-z]{24})', loginRequired, page.api.redirector);
  app.get('/_r/:id([0-9a-z]{24})', loginRequired, page.api.redirector); // alias
  // Legacy back-compat: the previous `/files/:id` direct-delivery handler was
  // broken by Step 3 of the plugin storage RFC (driver.get() now returns a
  // Readable, which the old `res.sendFile()` codepath cannot consume).
  // Redirect to the new ts-rest endpoint instead. The fileAccessRightOrLoginRequired
  // middleware stays so Share-token URLs still pass through (the redirect target
  // requires JWT auth — Share access for attachments is tracked as a separate
  // migration task; see openQuestions in migrate-attachments).
  app.get('/files/:id([0-9a-z]{24})', fileAccessRightOrLoginRequired, (req, res) => {
    res.redirect(302, `/api/v2/attachments/${req.params.id}`);
  });

  app.get('/_search', loginRequired, search.searchPage);
  app.get('/_api/search', accessTokenParser, loginRequired, search.api.search);

  app.get('/_share/:uuid([0-9a-z-]{36})', share.pageShow);

  app.get('/user/:username([^/]+)/bookmarks', loginRequired, page.userBookmarkList);
  app.get('/user/:username([^/]+)/recent-create', loginRequired, page.userRecentCreatedList);

  // HTTP RPC Styled API (に徐々に移行していいこうと思う)
  app.get('/_api/backlink.list', accessTokenParser, loginRequired, backlink.api.list);
  app.get('/_api/check_username', user.api.checkUsername);
  app.get('/_api/shares/accesses.list', accessTokenParser, loginRequired, shareAccess.api.list);
  app.get('/_api/user/recentlyViewed', loginRequired, user.api.getRecentlyViewedPages);
  app.get('/_api/users.list', accessTokenParser, loginRequired, user.api.list);
  app.post('/_api/me/picture/upload', loginRequired, uploads.single('userPicture'), me.api.uploadPicture);
  app.post('/_api/slack/event', slack.api.handleEvent);

  app.post('/_/edit', form.revision, loginRequired, csrf, page.pageEdit);
  app.get('/trash/$', loginRequired, page.deletedPageListShow);
  app.get('/trash/*/$', loginRequired, page.deletedPageListShow);
  app.get('/*/$', loginRequired, encodeSpace, page.pageListShow);
  app.get('/user/:username([^/]+)', loginRequired, page.userPageShow);
  app.get('/*', loginRequired, encodeSpace, page.pageShow);
};
