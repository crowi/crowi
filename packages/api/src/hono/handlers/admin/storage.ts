/**
 * RFC-0006 Phase 4 Batch 9 — `admin.storage` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/storage.ts`. One
 * admin-only endpoint:
 *
 *   GET /admin/storage   — active storage driver + installed list
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/storage/*` + the bare `/admin/storage` path.
 */
import { type StorageDriverEntry, adminStorageRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';

export const registerAdminStorageRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/storage/*', createJwtAdminRequired(crowi));
  app.use('/admin/storage', createJwtAdminRequired(crowi));

  return app.openapi(adminStorageRoutes.getStorageStatusRoute, async (c) => {
    const plugins = crowi.getPlugins();
    const activeDriver = plugins.active.storage;
    const list = plugins.storage.list();

    const activeEntry = activeDriver ? plugins.storage.entryOf(activeDriver) : undefined;
    const activeName = activeEntry?.driverName ?? null;
    const activePlugin = activeEntry?.plugin ?? null;

    const drivers: StorageDriverEntry[] = list.map((entry) => ({
      driverName: entry.driverName,
      pluginName: entry.plugin,
      isActive: entry.driverName === activeName,
    }));

    return c.json(
      {
        active: activeName && activePlugin ? { driverName: activeName, pluginName: activePlugin } : null,
        drivers,
      },
      200,
    );
  });
};
