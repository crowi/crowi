import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:installer');

const isAppInstalled = (req: { config?: { crowi?: Record<string, unknown> } }): boolean => {
  const config = req.config;
  if (!config || !config.crowi) return false;
  // Seed only contains 'app:url'; anything beyond that means setup ran.
  return Object.keys(config.crowi).length > 1;
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Config = crowi.model('Config');
  const User = crowi.model('User');

  const installerRouter = s.router(apiContract.installer, {
    getStatus: async ({ req }) => {
      if (isAppInstalled(req)) {
        return { status: 200 as const, body: { status: 'already_installed' } };
      }
      return { status: 200 as const, body: { status: 'installer_required' } };
    },

    createAdmin: async ({ body, req }) => {
      if (isAppInstalled(req)) {
        return {
          status: 400 as const,
          body: { status: 'error', message: 'Application is already installed' },
        };
      }

      const { name, username, email, password } = body.registerForm;

      try {
        const userData = await new Promise<UserDocument>((resolve, reject) => {
          // Seed admin language: legacy detected via i18next on the request;
          // we don't have that on the new pipeline, so default to English.
          User.createUserByEmailAndPassword(name, username, email, password, 'en', (err: Error | null, user: UserDocument) => {
            if (err) return reject(err);
            resolve(user);
          });
        });

        await new Promise<void>((resolve, reject) => {
          userData.makeAdmin((err: Error | null) => {
            if (err) return reject(err);
            resolve();
          });
        });

        await Config.applicationInstall();

        return { status: 200 as const, body: { status: 'ok', message: 'Admin created successfully' } };
      } catch (err) {
        const message = (err as Error).message;
        debug('Error creating admin:', message);
        return {
          status: 200 as const,
          body: { status: 'error', errors: [`管理ユーザーの作成に失敗しました。${message}`] },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.installer, installerRouter, router);
  return router;
};
