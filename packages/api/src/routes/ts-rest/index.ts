import Crowi from 'src/crowi';
import { Express, Router } from 'express';
// RFC-0006 Phase 3 — `app` resource moved to Hono (handler:
// `packages/api/src/hono/handlers/app.ts`).
// RFC-0006 Phase 4 Batch 1 — `installer` + `tokenAuth` resources moved
// to Hono (`hono/handlers/installer.ts`, `hono/handlers/tokenAuth.ts`);
// the legacy `auth` SSR resource (`/api/v2/login` / `/api/v2/register`
// etc.) was deleted outright because no frontend consumer existed.
// The `publicRouter` Express stage was therefore retired — every
// remaining ts-rest resource needs auth.
// RFC-0006 Phase 4 Batch 2 — `me` resource moved to Hono
// (`hono/handlers/me.ts`). The ts-rest router file was deleted.
import pageRoutes from './page';
import pagePreviewRoutes from './page-preview';
import pageCollabRoutes from './page-collab';
import presenceRoutes from './presence';
import userRoutes from './user';
import commentRoutes from './comment';
import bookmarkRoutes from './bookmark';
import revisionRoutes from './revision';
import notificationRoutes from './notification';
import backlinkRoutes from './backlink';
import draftRoutes from './draft';
import autocompleteRoutes from './autocomplete';
import attachmentRoutes from './attachment';
import searchRoutes from './search';
import adminCryptoRoutes from './adminCrypto';
import adminRoutes from './admin';
import jwtAuth from '../../middlewares/jwtAuth';
import jwtAdminRequired from '../../middlewares/jwtAdminRequired';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest');

export default (crowi: Crowi, app: Express) => {
  debug('Mounting ts-rest routes...');

  // ========================================
  // Authentication Layer Structure
  // ========================================
  // 1. Authenticated routes (JWT authentication required)
  // 2. Admin routes (JWT authentication + admin permission required)
  // ========================================
  // Public routes are now exclusively served by Hono (see
  // `packages/api/src/hono/handlers/`); no ts-rest public router is
  // mounted on `/api/v2` any more.

  // Authenticated Router - JWT authentication required
  const authenticatedRouter = Router();
  authenticatedRouter.use(jwtAuth(crowi)); // Apply JWT auth to all routes

  const pageRouter = pageRoutes(crowi, app);
  const pagePreviewRouter = pagePreviewRoutes(crowi, app);
  const pageCollabRouter = pageCollabRoutes(crowi, app);
  const presenceRouter = presenceRoutes(crowi, app);
  const userRouter = userRoutes(crowi, app);
  const commentRouter = commentRoutes(crowi, app);
  const bookmarkRouter = bookmarkRoutes(crowi, app);
  const revisionRouter = revisionRoutes(crowi, app);
  const notificationRouter = notificationRoutes(crowi, app);
  const backlinkRouter = backlinkRoutes(crowi, app);
  const draftRouter = draftRoutes(crowi, app);
  const autocompleteRouter = autocompleteRoutes(crowi, app);
  const attachmentRouter = attachmentRoutes(crowi, app);
  const searchRouter = searchRoutes(crowi, app);

  debug('Mounting authenticated routes (JWT required)');
  // Draft + autocomplete routes mount before pageRouter so the exact
  // `/pages/drafts` and `/pages/autocomplete` paths are matched ahead
  // of any broad `/pages/*` pattern.
  authenticatedRouter.use(draftRouter);
  authenticatedRouter.use(autocompleteRouter);
  authenticatedRouter.use(pageRouter);
  authenticatedRouter.use(pagePreviewRouter);
  authenticatedRouter.use(pageCollabRouter);
  authenticatedRouter.use(presenceRouter);
  authenticatedRouter.use(userRouter);
  authenticatedRouter.use(commentRouter);
  authenticatedRouter.use(bookmarkRouter);
  authenticatedRouter.use(revisionRouter);
  authenticatedRouter.use(notificationRouter);
  authenticatedRouter.use(backlinkRouter);
  authenticatedRouter.use(attachmentRouter);
  authenticatedRouter.use(searchRouter);

  // Admin Router - JWT authentication + admin permission required
  const adminRouter = Router();
  adminRouter.use(jwtAdminRequired(crowi)); // Apply JWT auth + admin check

  const adminCryptoRouter = adminCryptoRoutes(crowi, app);
  const adminSubRouter = adminRoutes(crowi, app);

  debug('Mounting admin routes (JWT + admin required)');
  adminRouter.use(adminCryptoRouter);
  adminRouter.use(adminSubRouter);

  // Mount all routers under /api/v2
  app.use('/api/v2', authenticatedRouter);
  app.use('/api/v2', adminRouter);

  debug('All ts-rest routes mounted successfully');
};
