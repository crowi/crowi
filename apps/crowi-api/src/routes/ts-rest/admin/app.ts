import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { registrationMode } from 'src/models/config';
import { coerceBoolean, coerceString, getCrowiConfigNamespace } from 'src/util/admin-config';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:app');

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Config = crowi.model('Config');

  const router_ = s.router(apiContract.admin.app, {
    /**
     * Returns the current `app:*` slice plus a few derived read-only
     * fields the App admin page header displays.
     *
     * AWS S3 credentials are no longer surfaced here. They live under the
     * per-plugin settings page (`/admin/plugins?name=@crowi/plugin-aws`)
     * since the storage plugin extraction. Boot-time migration moves the
     * legacy `upload:aws:*` keys into the new namespace — see
     * `src/util/aws-config-migration.ts`.
     */
    getAppSettings: async () => {
      const crowiNs = getCrowiConfigNamespace(crowi);
      const isUploadable = Config.isUploadable();

      return {
        status: 200 as const,
        body: {
          app: {
            title: coerceString(crowiNs['app:title']),
            confidential: coerceString(crowiNs['app:confidential']),
            externalShare: coerceBoolean(crowiNs['app:externalShare']),
          },
          isUploadable,
          registrationMode,
        },
      };
    },

    /**
     * Partial update of `app:*`. Storage credentials are intentionally
     * unsupported here; the contract's strict() catches stray `upload`
     * fields with a 400 so stale clients fail loudly.
     */
    updateAppSettings: async ({ body }) => {
      const updates: Record<string, unknown> = {};

      if (body.app) {
        if (body.app.title !== undefined) updates['app:title'] = body.app.title;
        if (body.app.confidential !== undefined) updates['app:confidential'] = body.app.confidential;
      }

      if (Object.keys(updates).length > 0) {
        debug('updateAppSettings keys=%o', Object.keys(updates));
        await crowi.getConfigService().saveConfig('crowi', updates);
      }

      return { status: 200 as const, body: { ok: true as const } };
    },
  });

  createExpressEndpoints(apiContract.admin.app, router_, router);
  return router;
};
