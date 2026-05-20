import { Readable } from 'node:stream';

import type { Express, NextFunction, Request as ExpressRequest, Response } from 'express';
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

  // RFC-0006 Phase 3 — Hono mount (ordered BEFORE ts-rest).
  //
  // Build the Hono app once at boot and dispatch matching `/api/v2/*`
  // requests to it via `app.fetch(Request) -> Response`. The Phase-2
  // implementation used `@hono/node-server`'s `getRequestListener`
  // which writes directly to the Node `res`; that prevented us from
  // detecting Hono's 404 and falling through to ts-rest. Now we drive
  // `honoApp.fetch` directly, inspect the returned `Response` status,
  // and call Express `next()` for 404s so ts-rest can take over for
  // un-migrated resources.
  //
  // Mount order rationale: ts-rest's authenticatedRouter installs
  // `jwtAuth` greedily on every `/api/v2/*` path, so a Phase-3 public
  // Hono route (`GET /app/info`) would be intercepted with 401 if
  // Hono ran AFTER ts-rest. Putting Hono first lets it serve its
  // known routes; for everything else the fall-through hands off to
  // ts-rest, which still owns every un-migrated resource. As Phase 4
  // commits land more resources, those ts-rest mounts are removed
  // and the path is served exclusively by Hono.
  //
  // Phase 6 cleanup deletes the Express host entirely and replaces
  // this with `serve({ fetch: honoApp.fetch, createServer:
  // http.createServer })` (see
  // `.feature-state/specs/feature-hono-integration.md`).
  const honoApp = buildHonoApp(crowi);
  app.use('/api/v2', async (req: ExpressRequest, res: Response, next: NextFunction) => {
    try {
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
      const host = req.headers.host ?? 'localhost';
      // `app.use('/api/v2', ...)` strips the mount prefix from
      // `req.url` (Express convention). Our Hono routes are declared
      // without the `/api/v2` prefix (e.g. `path: '/app/info'`), so
      // the stripped `req.url` is exactly what Hono needs to match.
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
        // express.json() / express.urlencoded() already parsed the
        // body; reserialize it so Hono receives the wire-shape it
        // would have read off the wire. Phase 6 removes Express body
        // parsing entirely, eliminating this round-trip.
        const body = (req as ExpressRequest & { body?: unknown }).body;
        if (body !== undefined && body !== null) {
          if (typeof body === 'string' || body instanceof Buffer) {
            init.body = body instanceof Buffer ? new Uint8Array(body) : body;
          } else {
            init.body = JSON.stringify(body);
            if (!headers.has('content-type')) headers.set('content-type', 'application/json');
          }
          // The original `content-length` reflects the wire bytes Express
          // already read; after reserialization it no longer matches the
          // outgoing body. Drop it so Hono / fetch recompute as needed.
          headers.delete('content-length');
        }
      }

      const response = await honoApp.fetch(new Request(url, init));

      if (response.status === 404) {
        // Hono returned the not-found fallback (no route matched).
        // Hand the request off to the next Express middleware so
        // ts-rest gets a chance. 5xx and other non-404 responses are
        // returned verbatim — they came from Hono's `onError` or a
        // handler-level mapping and must not fall through.
        return next();
      }

      res.status(response.status);
      // `Set-Cookie` may appear multiple times; the standard Headers iterator
      // collapses them in `forEach`, so use `getSetCookie()` to preserve every
      // entry and forward the rest of the headers via `forEach`.
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
      // Stream the body straight through instead of buffering — Phase 4
      // adds attachment / search routes that can produce large payloads.
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
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
