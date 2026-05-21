/**
 * RFC-0006 Phase 4 Batch 9 — `admin.share` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/share.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/share   — read the single `app:externalShare` toggle
 *   PUT /admin/share   — persist it
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/share/*` + the bare `/admin/share` path.
 */
import { type ShareSettings, adminShareRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceBoolean, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:share');

const KEY_EXTERNAL_SHARE = 'app:externalShare';

const readShareSettings = (crowi: Crowi): ShareSettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    externalShare: coerceBoolean(ns[KEY_EXTERNAL_SHARE]),
  };
};

export const registerAdminShareRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/share/*', createJwtAdminRequired(crowi));
  app.use('/admin/share', createJwtAdminRequired(crowi));

  return app
    .openapi(adminShareRoutes.getShareSettingsRoute, async (c) => {
      return c.json(readShareSettings(crowi), 200);
    })
    .openapi(adminShareRoutes.updateShareSettingsRoute, async (c) => {
      const body = c.req.valid('json');

      try {
        await crowi.getConfigService().saveConfig('crowi', {
          [KEY_EXTERNAL_SHARE]: body.externalShare,
        });
      } catch (err) {
        debug('Error saving share settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      return c.json(readShareSettings(crowi), 200);
    });
};
