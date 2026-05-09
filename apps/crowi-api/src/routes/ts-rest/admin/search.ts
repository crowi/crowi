import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type SearchDriverEntry } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const searchRouter = s.router(apiContract.admin.search, {
    /**
     * GET /api/v2/admin/search
     *
     * Returns the active search driver pointer and the full list of
     * registered drivers. Authorization is handled by the surrounding
     * adminRouter middleware (`jwtAdminRequired`); this handler only runs
     * for authenticated admins.
     *
     * Active resolution mirrors `admin/storage.ts`: walk `search.list()`
     * and find the entry whose driver instance is `===` the resolved
     * active driver. Reference equality is safe because `DriverRegistry`
     * stores each driver instance once.
     *
     * `supportsRebuild` is `typeof driver.rebuild === 'function'` — the
     * registry interface declares `rebuild?` as optional, so drivers
     * without a persistent index (e.g. Mongo regex) won't expose it. The
     * web admin uses this flag to gate the `crowi-admin search rebuild`
     * hint.
     */
    getSearchStatus: async () => {
      const plugins = crowi.getPlugins();
      const activeDriver = plugins.active.search;
      const list = plugins.search.list();

      let activeName: string | null = null;
      let activePlugin: string | null = null;
      let activeSupportsRebuild = false;
      if (activeDriver) {
        for (const entry of list) {
          if (plugins.search.get(entry.driverName) === activeDriver) {
            activeName = entry.driverName;
            activePlugin = entry.plugin;
            activeSupportsRebuild = typeof activeDriver.rebuild === 'function';
            break;
          }
        }
      }

      const drivers: SearchDriverEntry[] = list.map((entry) => {
        const instance = plugins.search.get(entry.driverName);
        return {
          driverName: entry.driverName,
          pluginName: entry.plugin,
          isActive: entry.driverName === activeName,
          supportsRebuild: typeof instance?.rebuild === 'function',
        };
      });

      return {
        status: 200 as const,
        body: {
          active: activeName && activePlugin ? { driverName: activeName, pluginName: activePlugin, supportsRebuild: activeSupportsRebuild } : null,
          drivers,
        },
      };
    },
  });

  createExpressEndpoints(apiContract.admin.search, searchRouter, router);

  return router;
};
