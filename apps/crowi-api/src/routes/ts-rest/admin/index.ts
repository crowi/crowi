import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import appRoutes from './app';
import authRoutes from './auth';
import mailRoutes from './mail';
import pluginsRoutes from './plugins';
import searchRoutes from './search';
import securityRoutes from './security';
import shareRoutes from './share';
import storageRoutes from './storage';
import usersRoutes from './users';

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
  router.use(mailRoutes(crowi, app));
  router.use(shareRoutes(crowi, app));
  router.use(storageRoutes(crowi, app));
  router.use(searchRoutes(crowi, app));
  router.use(usersRoutes(crowi, app));
  router.use(pluginsRoutes(crowi, app));

  return router;
};
