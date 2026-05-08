import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import appRoutes from './app';
import authRoutes from './auth';
import securityRoutes from './security';

/**
 * Aggregate router for all admin-only ts-rest endpoints. Mounted under the
 * adminRouter in `routes/ts-rest/index.ts` which already applies
 * `jwtAdminRequired` (JWT + admin permission). Individual sub-routers should
 * therefore not re-implement authorization.
 */
export default (crowi: Crowi, app: Express) => {
  const router = Router();

  router.use(appRoutes(crowi, app));
  router.use(authRoutes(crowi, app));
  router.use(securityRoutes(crowi, app));

  return router;
};
