import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type ShareSettings } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:share');

/**
 * Coerce an unknown config value to boolean using the same convention used
 * by `admin/app.ts:asBoolean`. Stored Config values are JSON-parsed at load
 * time (see ConfigModel.loadAllConfig), so for a boolean key we typically
 * already get `true`/`false`/`undefined`. Only strict `=== true` counts as
 * enabled — anything else (undefined, null, 'true' string, 0, etc.) maps
 * to `false`. This matches the legacy `isExternalShareEnabled()` check in
 * `controllers/share.ts`.
 */
const asBoolean = (value: unknown): boolean => value === true;

const KEY_EXTERNAL_SHARE = 'app:externalShare';

/**
 * Read the current share-related settings from the in-memory config cache.
 * Defaults to `{ externalShare: false }` when the key is missing — same as
 * `models/config.ts` defaults for a fresh install.
 */
const readShareSettings = (crowi: Crowi): ShareSettings => {
  const cfg = crowi.getConfig();
  const ns = (cfg && typeof cfg === 'object' ? (cfg as { crowi?: Record<string, unknown> }).crowi : undefined) ?? {};

  return {
    externalShare: asBoolean(ns[KEY_EXTERNAL_SHARE]),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const shareRouter = s.router(apiContract.admin.share, {
    /**
     * GET /api/v2/admin/share
     * Returns the current `app:externalShare` setting. Authorization is
     * handled by the surrounding adminRouter middleware; this handler only
     * runs for authenticated admins.
     */
    getShareSettings: async () => {
      // crowi.getConfig() is a synchronous in-memory cache read; no try/catch
      // needed here. The PUT path keeps its catch because saveConfig is async.
      return { status: 200 as const, body: readShareSettings(crowi) };
    },

    /**
     * PUT /api/v2/admin/share
     * Persists the `app:externalShare` toggle via
     * `configService.saveConfig('crowi', ...)`. saveConfig merges into the
     * existing `crowi` namespace, so unrelated keys (`app:title`, `mail:*`,
     * `security:*`, ...) are not touched.
     *
     * Returns the post-save settings so the UI doesn't need a follow-up GET.
     */
    updateShareSettings: async ({ body }) => {
      const configService = crowi.getConfigService();

      try {
        await configService.saveConfig('crowi', {
          [KEY_EXTERNAL_SHARE]: body.externalShare,
        });
      } catch (err) {
        const error = err as Error;
        debug('Error saving share settings:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }

      // Re-read from the in-memory cache (saveConfig updates it) so the
      // response reflects the new value without an extra Mongo round-trip.
      return { status: 200 as const, body: readShareSettings(crowi) };
    },
  });

  createExpressEndpoints(apiContract.admin.share, shareRouter, router);

  return router;
};
