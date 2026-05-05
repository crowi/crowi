import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import authRoutes from './auth';
import installerRoutes from './installer';
import tokenAuthRoutes from './tokenAuth';
import meRoutes from './me';
import pageRoutes from './page';
import userRoutes from './user';
import commentRoutes from './comment';
import bookmarkRoutes from './bookmark';
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
  const authRouter = authRoutes(crowi, app); // Legacy - to be removed
  const installerRouter = installerRoutes(crowi, app);
  const tokenAuthRouter = tokenAuthRoutes(crowi, app);

  debug('Mounting public routes (no auth required)');
  publicRouter.use(authRouter);
  publicRouter.use(installerRouter);
  publicRouter.use(tokenAuthRouter);

  // Authenticated Router - JWT authentication required
  const authenticatedRouter = Router();
  authenticatedRouter.use(jwtAuth(crowi)); // Apply JWT auth to all routes

  const meRouter = meRoutes(crowi, app);
  const pageRouter = pageRoutes(crowi, app);
  const userRouter = userRoutes(crowi, app);
  const commentRouter = commentRoutes(crowi, app);
  const bookmarkRouter = bookmarkRoutes(crowi, app);

  debug('Mounting authenticated routes (JWT required)');
  authenticatedRouter.use(meRouter);
  authenticatedRouter.use(pageRouter);
  authenticatedRouter.use(userRouter);
  authenticatedRouter.use(commentRouter);
  authenticatedRouter.use(bookmarkRouter);

  // Admin Router - JWT authentication + admin permission required
  const adminRouter = Router();
  adminRouter.use(jwtAdminRequired(crowi)); // Apply JWT auth + admin check

  debug('Mounting admin routes (JWT + admin required)');
  // TODO: Add admin-only routes here
  // Example: adminRouter.use(adminSettingsRouter);

  // Mount all routers under /api/v2
  app.use('/api/v2', publicRouter);
  app.use('/api/v2', authenticatedRouter);
  app.use('/api/v2', adminRouter);

  debug('All ts-rest routes mounted successfully');
};
