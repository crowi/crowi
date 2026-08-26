/**
 * RFC-0006 Phase 4 Batch 9 — `admin.app` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/app.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/app   — read the current `app:*` slice (plus derived
 *                       fields the App admin page header displays)
 *   PUT /admin/app   — partial update of `app:*`
 *
 * Auth:
 *   - Both endpoints are admin-only. The handler installs
 *     `createJwtAdminRequired(crowi)` broadly on `/admin/app/*` and the
 *     bare `/admin/app` literal (no nested routes today, but the broad
 *     apply future-proofs sub-paths). Same install pattern as the other
 *     8 Batch 9 admin sub-contracts.
 *
 * Wire-format parity:
 *   - The 503-shaped validation envelope follows the legacy `bodyResult`
 *     shape via the contract's `hook` override (see
 *     `contracts/admin/app.ts:appSettingsValidationHook`).
 */
import { adminAppRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceBoolean, coerceString, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';
import { registrationMode } from 'src/models/config';

const debug = Debug('crowi:hono:handlers:admin:app');

export const registerAdminAppRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Config = crowi.model('Config');

  // `/admin/app/*` plus the bare `/admin/app` literal. Hono routes the
  // bare path separately from the wildcard family (the `*` matches one
  // or more segments), so both installs are required.
  app.use('/admin/app/*', createJwtAdminRequired(crowi));
  app.use('/admin/app', createJwtAdminRequired(crowi));

  return app
    .openapi(adminAppRoutes.getAppSettingsRoute, async (c) => {
      const crowiNs = getCrowiConfigNamespace(crowi);
      const isUploadable = Config.isUploadable();
      return c.json(
        {
          app: {
            title: coerceString(crowiNs['app:title']),
            confidential: coerceString(crowiNs['app:confidential']),
          },
          isUploadable,
          registrationMode,
          setupChecklistDismissed: coerceBoolean(crowiNs['app:setupChecklistDismissed']),
        },
        200,
      );
    })
    .openapi(adminAppRoutes.updateAppSettingsRoute, async (c) => {
      const body = c.req.valid('json');
      const updates: Record<string, unknown> = {};

      if (body.app) {
        if (body.app.title !== undefined) updates['app:title'] = body.app.title;
        if (body.app.confidential !== undefined) updates['app:confidential'] = body.app.confidential;
      }

      if (body.setupChecklistDismissed !== undefined) {
        updates['app:setupChecklistDismissed'] = body.setupChecklistDismissed;
      }

      if (Object.keys(updates).length > 0) {
        debug('updateAppSettings keys=%o', Object.keys(updates));
        try {
          await crowi.getConfigService().saveConfig('crowi', updates);
        } catch (err) {
          debug('Error saving app settings:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      }

      return c.json({ ok: true as const }, 200);
    });
};
