import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import loginController from '../../controllers/login';
import applicationInstalled from '../../middlewares/applicationInstalled';
import csrfVerify from '../../middlewares/csrfVerify';
import form from '../../form';

export default (crowi: Crowi, app: Express) => {
  const Login = loginController(crowi, app);
  const s = initServer();
  const router = Router();
  const csrf = csrfVerify(crowi);

  const authRouter = s.router(apiContract.auth, {
    login: async ({ req, res }) => {
      return new Promise((resolve) => {
        Login.login(
          req as any,
          {
            json: (data) => resolve({ status: 200, body: data }),
            redirect: () => resolve({ status: 200, body: {} }),
          } as any,
        );
      });
    },
    loginPost: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        Login.login(request, {
          json: (data) => resolve({ status: 400, body: { errors: request.form?.errors || [] } }),
          redirect: () => resolve({ status: 200, body: undefined }),
        } as any);
      });
    },
    register: async ({ req, res }) => {
      return new Promise((resolve) => {
        Login.register(
          req as any,
          {
            json: (data) => resolve({ status: 200, body: data }),
            redirect: () => resolve({ status: 200, body: {} }),
          } as any,
        );
      });
    },
    registerPost: async ({ body, req, res }) => {
      return new Promise((resolve) => {
        const request = req as any;
        request.body = body;

        Login.register(request, {
          json: (data) => resolve({ status: 400, body: { errors: request.form?.errors || [] } }),
          redirect: () => resolve({ status: 200, body: undefined }),
        } as any);
      });
    },
    loginError: async ({ params }) => {
      return new Promise((resolve) => {
        Login.error(
          { params } as any,
          {
            status: (code) => ({
              json: (data) => resolve({ status: 403 as const, body: data }),
            }),
          } as any,
        );
      });
    },
  });

  createExpressEndpoints(apiContract.auth, authRouter, router);

  // Apply middleware to specific routes
  router.use('/login', applicationInstalled);
  router.use('/register', applicationInstalled);

  return router;
};
