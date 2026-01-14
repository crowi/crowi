import Crowi from 'src/crowi';
import { Express } from 'express';
import authRoutes from './auth';
import installerRoutes from './installer';
import tokenAuthRoutes from './tokenAuth';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest');

export default (crowi: Crowi, app: Express) => {
  debug('Mounting ts-rest routes...');
  // Mount the ts-rest routes
  // Note: These routes run alongside the existing Express routes
  // We're keeping both implementations temporarily for comparison

  // Prefix ts-rest routes with /api/v2 to avoid conflicts during migration
  const authRouter = authRoutes(crowi, app); // Legacy - to be removed
  const installerRouter = installerRoutes(crowi, app);
  const tokenAuthRouter = tokenAuthRoutes(crowi, app);

  debug('Mounting auth router at /api/v2');
  app.use('/api/v2', authRouter);
  debug('Mounting installer router at /api/v2');
  app.use('/api/v2', installerRouter);
  debug('Mounting tokenAuth router at /api/v2');
  app.use('/api/v2', tokenAuthRouter);
  
  debug('All ts-rest routes mounted successfully');

  // TODO: Once tested, we'll migrate middleware handling into the ts-rest handlers
  // and remove the original Express routes
};
