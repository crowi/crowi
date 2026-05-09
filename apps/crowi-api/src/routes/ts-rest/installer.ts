import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import type { ConfigModel } from 'src/models/config';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:installer');

/**
 * The ConfigService keeps a boot-time snapshot of all Config docs in memory,
 * but `Config.applicationInstall()` writes new docs without refreshing it —
 * so `req.config.crowi` is unreliable as an installed-state oracle. Always
 * count from the DB instead, and refresh the cache after a successful install
 * so other request paths see the new values without a server restart.
 */
const isAppInstalled = async (Config: ConfigModel): Promise<boolean> => {
  const count = await Config.countDocuments({ ns: 'crowi' }).exec();
  return count > 0;
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Config = crowi.model('Config');
  const User = crowi.model('User');

  const installerRouter = s.router(apiContract.installer, {
    getStatus: async () => {
      const installed = await isAppInstalled(Config);
      return {
        status: 200 as const,
        body: { status: installed ? ('already_installed' as const) : ('installer_required' as const) },
      };
    },

    createAdmin: async ({ body }) => {
      if (await isAppInstalled(Config)) {
        return {
          status: 400 as const,
          body: { status: 'error', message: 'Application is already installed' },
        };
      }

      const { name, username, email, password } = body.registerForm;

      try {
        const userData = await new Promise<UserDocument>((resolve, reject) => {
          // Seed admin language defaults to English; the legacy flow sniffed
          // i18next from the request, but we don't have that on this pipeline.
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
        await crowi.getConfigService().load();

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
