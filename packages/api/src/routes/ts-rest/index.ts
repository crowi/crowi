import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import appRoutes from './app';
import authRoutes from './auth';
import installerRoutes from './installer';
import tokenAuthRoutes from './tokenAuth';
import meRoutes from './me';
import pageRoutes from './page';
import pagePreviewRoutes from './page-preview';
import userRoutes from './user';
import commentRoutes from './comment';
import bookmarkRoutes from './bookmark';
import revisionRoutes from './revision';
import notificationRoutes from './notification';
import backlinkRoutes from './backlink';
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
  // 1. Public routes (no authentication required)
  // 2. Authenticated routes (JWT authentication required)
  // 3. Admin routes (JWT authentication + admin permission required)
  // ========================================

  // Public Router - No authentication required
  const publicRouter = Router();
  const appRouter = appRoutes(crowi, app);
  const authRouter = authRoutes(crowi, app); // Legacy - to be removed
  const installerRouter = installerRoutes(crowi, app);
  const tokenAuthRouter = tokenAuthRoutes(crowi, app);

  debug('Mounting public routes (no auth required)');
  publicRouter.use(appRouter);
  publicRouter.use(authRouter);
  publicRouter.use(installerRouter);
  publicRouter.use(tokenAuthRouter);

  // Authenticated Router - JWT authentication required
  const authenticatedRouter = Router();
  authenticatedRouter.use(jwtAuth(crowi)); // Apply JWT auth to all routes

  const meRouter = meRoutes(crowi, app);
  const pageRouter = pageRoutes(crowi, app);
  const pagePreviewRouter = pagePreviewRoutes(crowi, app);
  const userRouter = userRoutes(crowi, app);
  const commentRouter = commentRoutes(crowi, app);
  const bookmarkRouter = bookmarkRoutes(crowi, app);
  const revisionRouter = revisionRoutes(crowi, app);
  const notificationRouter = notificationRoutes(crowi, app);
  const backlinkRouter = backlinkRoutes(crowi, app);
  const attachmentRouter = attachmentRoutes(crowi, app);
  const searchRouter = searchRoutes(crowi, app);

  debug('Mounting authenticated routes (JWT required)');
  authenticatedRouter.use(meRouter);
  authenticatedRouter.use(pageRouter);
  authenticatedRouter.use(pagePreviewRouter);
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
  app.use('/api/v2', publicRouter);
  app.use('/api/v2', authenticatedRouter);
  app.use('/api/v2', adminRouter);

  debug('All ts-rest routes mounted successfully');
};
