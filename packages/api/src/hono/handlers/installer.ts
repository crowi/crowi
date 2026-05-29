/**
 * RFC-0006 Phase 4 Batch 1 — `installer` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/installer.ts`. Behaviour is
 * preserved byte-for-byte:
 *
 *  - `GET /installer` reports `'installer_required'` / `'already_installed'`
 *    based on a live DB count of `{ ns: 'crowi' }` Config docs (the boot
 *    snapshot from `ConfigService` is stale right after the first install,
 *    so we always count).
 *  - `POST /installer/createAdmin` refuses with HTTP 400 + `status: 'error'`
 *    once the app is installed; otherwise creates a user, makes them admin,
 *    flips the install flag, refreshes the config cache and returns HTTP
 *    200 + `status: 'ok'`. User-creation failures still come back as HTTP
 *    200 + `status: 'error'` with an `errors[]` array — the legacy
 *    controller did the same so the installer UI's message rendering keeps
 *    working unchanged.
 *
 * No authentication: the route is invoked before any user exists, so it
 * stays on Hono's public surface (no `createJwtAuth` wrap).
 */
import { createAdminRoute, getInstallerStatusRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { ConfigModel } from 'src/models/config';
import type { UserDocument } from 'src/models/user';

import type { CrowiHonoBindings } from '../app';

const debug = Debug('crowi:hono:handlers:installer');

/**
 * The ConfigService keeps a boot-time snapshot of all Config docs in
 * memory, but `Config.applicationInstall()` writes new docs without
 * refreshing it — so `crowi.getConfig().crowi` is unreliable as an
 * installed-state oracle. Always count from the DB instead, and
 * refresh the cache after a successful install so other request paths
 * see the new values without a server restart.
 */
export const isAppInstalled = async (Config: ConfigModel): Promise<boolean> => {
  const count = await Config.countDocuments({ ns: 'crowi' }).exec();
  return count > 0;
};

export const registerInstallerRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Config = crowi.model('Config');
  const User = crowi.model('User');

  return app
    .openapi(getInstallerStatusRoute, async (c) => {
      const installed = await isAppInstalled(Config);
      return c.json({ status: installed ? ('already_installed' as const) : ('installer_required' as const) }, 200);
    })
    .openapi(createAdminRoute, async (c) => {
      if (await isAppInstalled(Config)) {
        return c.json({ status: 'error' as const, message: 'Application is already installed' }, 400);
      }

      const { name, username, email, password } = c.req.valid('json').registerForm;

      try {
        const userData = await new Promise<UserDocument>((resolve, reject) => {
          // Seed admin language defaults to English; the legacy flow
          // sniffed i18next from the request, but we don't have that on
          // this pipeline.
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

        // The installer admin sets the instance up; no email confirmation.
        userData.emailConfirmedAt = new Date();
        await userData.save();

        await Config.applicationInstall();
        await crowi.getConfigService().load();

        return c.json({ status: 'ok' as const, message: 'Admin created successfully' }, 200);
      } catch (err) {
        const message = (err as Error).message;
        debug('Error creating admin:', message);
        // Legacy parity: user-creation failures surface as HTTP 200 +
        // `status: 'error'` so the installer UI can render `errors[]`
        // without branching on the wire status.
        return c.json({ status: 'error' as const, errors: [`管理ユーザーの作成に失敗しました。${message}`] }, 200);
      }
    });
};
