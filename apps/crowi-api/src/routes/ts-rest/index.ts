import Crowi from 'src/crowi';
import { Express } from 'express';
import authRoutes from './auth';
import installerRoutes from './installer';
import tokenAuthRoutes from './tokenAuth';

export default (crowi: Crowi, app: Express) => {
  // Mount the ts-rest routes
  // Note: These routes run alongside the existing Express routes
  // We're keeping both implementations temporarily for comparison

  // Prefix ts-rest routes with /api/v2 to avoid conflicts during migration
  const authRouter = authRoutes(crowi, app); // Legacy - to be removed
  const installerRouter = installerRoutes(crowi, app);
  const tokenAuthRouter = tokenAuthRoutes(crowi, app);

  app.use('/api/v2', authRouter);
  app.use('/api/v2', installerRouter);
  app.use('/api/v2', tokenAuthRouter);

  // TODO: Once tested, we'll migrate middleware handling into the ts-rest handlers
  // and remove the original Express routes
};
