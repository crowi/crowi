import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import installerController from '../../controllers/installer';
import applicationNotInstalled from '../../middlewares/applicationNotInstalled';
import csrfVerify from '../../middlewares/csrfVerify';
import form from '../../form';

export default (crowi: Crowi, app: Express) => {
  const installer = installerController(crowi);
  const s = initServer();
  const router = Router();
  const csrf = csrfVerify(crowi);

  const installerRouter = s.router(apiContract.installer, {
    getStatus: async ({ req, res }) => {
      return new Promise((resolve) => {
        installer.index(
          req as any,
          {
            json: (data) => resolve({ status: 200, body: data }),
          } as any,
        );
      });
    },
    createAdmin: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        installer.createAdmin(request, {
          json: (data) => {
            if (data.status === 'error') {
              resolve({ status: 200, body: data });
            } else {
              resolve({ status: 302, body: undefined });
            }
          },
          redirect: () => resolve({ status: 302, body: undefined }),
        } as any);
      });
    },
  });

  // Apply middleware to installer routes BEFORE creating endpoints
  const notInstalledMiddleware = applicationNotInstalled();
  router.use('/installer', notInstalledMiddleware);

  createExpressEndpoints(apiContract.installer, installerRouter, router);

  return router;
};
