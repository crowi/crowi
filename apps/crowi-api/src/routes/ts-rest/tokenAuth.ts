import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import tokenAuthController from '../../controllers/tokenAuth';
import applicationInstalled from '../../middlewares/applicationInstalled';
import jwtAuth from '../../middlewares/jwtAuth';

export default (crowi: Crowi, app: Express) => {
  const TokenAuth = tokenAuthController(crowi, app);
  const s = initServer();
  const router = Router();
  const checkAppInstalled = applicationInstalled();
  const requireJwtAuth = jwtAuth(crowi);

  const tokenAuthRouter = s.router(apiContract.tokenAuth, {
    login: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        TokenAuth.login(request, {
          status: (code) => ({
            json: (data) => resolve({ status: code as any, body: data }),
          }),
          json: (data) => resolve({ status: 200, body: data }),
        } as any);
      });
    },

    register: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        TokenAuth.register(request, {
          status: (code) => ({
            json: (data) => resolve({ status: code as any, body: data }),
          }),
          json: (data) => resolve({ status: 201 as const, body: data }),
        } as any);
      });
    },

    refresh: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        TokenAuth.refresh(request, {
          status: (code) => ({
            json: (data) => resolve({ status: code as any, body: data }),
          }),
          json: (data) => resolve({ status: 200, body: data }),
        } as any);
      });
    },

    logout: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        // Apply JWT auth middleware
        requireJwtAuth(request, res as any, (err) => {
          if (err) {
            return resolve({ status: 401 as const, body: { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } } });
          }

          TokenAuth.logout(request, {
            json: (data) => resolve({ status: 200, body: data }),
          } as any);
        });
      });
    },

    me: async ({ req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;

        // Apply JWT auth middleware
        requireJwtAuth(request, res as any, (err) => {
          if (err) {
            return resolve({ status: 401 as const, body: { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } } });
          }

          TokenAuth.me(request, {
            status: (code) => ({
              json: (data) => resolve({ status: code as any, body: data }),
            }),
            json: (data) => resolve({ status: 200, body: data }),
          } as any);
        });
      });
    },
  });

  createExpressEndpoints(apiContract.tokenAuth, tokenAuthRouter, router);

  // Apply middleware to specific routes
  router.use('/auth/login', checkAppInstalled);
  router.use('/auth/register', checkAppInstalled);

  return router;
};
