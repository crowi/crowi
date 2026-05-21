import { Readable } from 'node:stream';

import type { Express, NextFunction, Request as ExpressRequest, Response } from 'express';
import Crowi from 'src/crowi';

import multer from 'multer';

import { buildHonoApp } from '../hono';
import { HONO_UNMATCHED_HEADER } from '../hono/app';
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

  // RFC-0006 Phase 6 Sub-batch B — production traffic no longer
  // reaches this `/api/v2` mount: `crowi/index.ts:start()` runs the
  // Hono app via `@hono/node-server`'s `createAdaptorServer`, so the
  // Express host below is invoked only via the `callExpressAsFetch`
  // fallback (= Hono `notFound`) for paths Hono does not match.
  //
  // The Express → Hono bridge survives Sub-batch B exclusively so
  // the existing supertest-based tests (32 files dialling `crowi.app`
  // at `/api/v2/*`) keep working. Sub-batch D deletes Express +
  // every supertest test in one sweep — migrating the tests to a
  // Hono-fetch shim is out of scope here.
  //
  // The bridge intentionally falls through to `next()` on any Hono
  // 404 so the legacy ts-rest mount below still serves un-migrated
  // resources during local dev; Sub-batch D removes both.
  const honoApp = buildHonoApp(crowi);
  app.use('/api/v2', async (req: ExpressRequest, res: Response, next: NextFunction) => {
    try {
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
      const host = req.headers.host ?? 'localhost';
      const url = `${proto}://${host}${req.url}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, String(value));
        }
      }

      const init: RequestInit = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const contentType = req.headers['content-type'] ?? '';
        const isParsedByExpress = /^application\/(json|x-www-form-urlencoded)/i.test(contentType);

        if (!isParsedByExpress && contentType) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const restoreBody = Buffer.concat(chunks);
          if (restoreBody.length > 0) {
            init.body = new Uint8Array(restoreBody);
          }
        } else {
          const body = (req as ExpressRequest & { body?: unknown }).body;
          if (body !== undefined && body !== null) {
            if (typeof body === 'string' || body instanceof Buffer) {
              init.body = body instanceof Buffer ? new Uint8Array(body) : body;
            } else {
              init.body = JSON.stringify(body);
              if (!headers.has('content-type')) headers.set('content-type', 'application/json');
            }
            headers.delete('content-length');
          }
        }
      }

      const response = await honoApp.fetch(new Request(url, init));

      if (response.status === 404 && response.headers.get(HONO_UNMATCHED_HEADER) === '1') {
        // Hono's `notFound` set the marker — no route matched. Hand off
        // to ts-rest / legacy Express below. Handler-emitted 404s
        // (e.g. `PAGE_NOT_FOUND`) don't trigger `notFound`, so they
        // bypass this branch and are forwarded verbatim.
        return next();
      }

      res.status(response.status);
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        res.setHeader(key, value);
      });
      if (setCookies.length > 0) {
        res.setHeader('set-cookie', setCookies);
      }

      if (response.body == null) {
        res.end();
        return;
      }
      const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      bodyStream.on('error', next);
      bodyStream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // Mount ts-rest routes (legacy stack — Phase 4+ removes resources
  // here one by one).
  TsRestRoutes(crowi, app);

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
