import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import installerController from '../../controllers/installer';
import csrfVerify from '../../middlewares/csrfVerify';
import form from '../../form';

export default (crowi: Crowi, app: Express) => {
  const installer = installerController(crowi);
  const s = initServer();
  const router = Router();
  const csrf = csrfVerify(crowi);

  // Helper to check if app is already installed
  const isAppInstalled = (req: any): boolean => {
    const config = req.config;
    return Object.keys(config.crowi).length !== 1;
  };

  const installerRouter = s.router(apiContract.installer, {
    getStatus: async ({ req, res }) => {
      // Check if app is already installed
      if (isAppInstalled(req)) {
        return {
          status: 200 as const,
          body: { status: 'already_installed' },
        };
      }

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
      // Check if app is already installed
      if (isAppInstalled(req)) {
        return {
          status: 400 as const,
          body: { status: 'error', message: 'Application is already installed' },
        };
      }

      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        installer.createAdmin(request, {
          json: (data) => {
            if (data.status === 'error') {
              resolve({ status: 200, body: data });
            } else {
              resolve({ status: 200, body: { status: 'ok', message: 'Admin created successfully' } });
            }
          },
          redirect: () => resolve({ status: 200, body: { status: 'ok', message: 'Admin created successfully' } }),
        } as any);
      });
    },
  });

  createExpressEndpoints(apiContract.installer, installerRouter, router);

  return router;
};
