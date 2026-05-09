import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type StorageDriverEntry } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const storageRouter = s.router(apiContract.admin.storage, {
    /**
     * GET /api/v2/admin/storage
     *
     * Returns the active storage driver pointer and the full list of
     * registered drivers. Authorization is handled by the surrounding
     * adminRouter middleware (`jwtAdminRequired`); this handler only runs
     * for authenticated admins.
     *
     * Active resolution: we look up the active driver instance from
     * `getPlugins().active.storage`, then walk `storage.list()` to find
     * the matching `(driverName, plugin)` pair. Comparing by reference is
     * safe — `DriverRegistry` stores each driver instance once, and
     * `resolveActiveDrivers` re-uses that exact instance.
     */
    getStorageStatus: async () => {
      const plugins = crowi.getPlugins();
      const activeDriver = plugins.active.storage;
      const list = plugins.storage.list();

      // Find which `(driverName, plugin)` pair resolves to the active
      // driver instance. Falls back to null when the active slot is
      // empty (legacy in-core handling — see PluginManager.resolveOrWarn).
      let activeName: string | null = null;
      let activePlugin: string | null = null;
      if (activeDriver) {
        for (const entry of list) {
          if (plugins.storage.get(entry.driverName) === activeDriver) {
            activeName = entry.driverName;
            activePlugin = entry.plugin;
            break;
          }
        }
      }

      const drivers: StorageDriverEntry[] = list.map((entry) => ({
        driverName: entry.driverName,
        pluginName: entry.plugin,
        isActive: entry.driverName === activeName,
      }));

      return {
        status: 200 as const,
        body: {
          active: activeName && activePlugin ? { driverName: activeName, pluginName: activePlugin } : null,
          drivers,
        },
      };
    },
  });

  createExpressEndpoints(apiContract.admin.storage, storageRouter, router);

  return router;
};
