/**
 * RFC-0006 Phase 4 Batch 9 — `admin.search` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/search.ts`. One
 * admin-only endpoint:
 *
 *   GET /admin/search   — active search driver + installed list
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/search/*` + the bare `/admin/search` path. Distinct from
 *     the user-facing `/search` endpoint (Batch 7).
 */
import { type SearchDriverEntry, adminSearchRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';

export const registerAdminSearchRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/search/*', createJwtAdminRequired(crowi));
  app.use('/admin/search', createJwtAdminRequired(crowi));

  return app.openapi(adminSearchRoutes.getSearchStatusRoute, async (c) => {
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

    return c.json(
      {
        active: activeName && activePlugin ? { driverName: activeName, pluginName: activePlugin, supportsRebuild: activeSupportsRebuild } : null,
        drivers,
      },
      200,
    );
  });
};
