/**
 * RFC-0006 Phase 4 Batch 9 — `admin.auth` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/auth.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/auth   — read the two `auth:*` settings
 *   PUT /admin/auth   — persist them (with inert-setting 400 guard)
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/auth/*` + the bare `/admin/auth` path.
 *
 * Inert-setting guard (2.0.0-alpha):
 *   - `requireThirdPartyAuth` / `disablePasswordAuth` both depend on
 *     third-party (Google / GitHub) sign-in, which was removed from core.
 *     `User.hasValidThirdPartyId()` is now permanently false, so enabling
 *     either would lock every account out of password login with no
 *     recovery path. The config keys + schema are kept (inert) for a future
 *     auth provider plugin, but the endpoint hard-rejects enabling them with
 *     400 `THIRD_PARTY_AUTH_UNAVAILABLE`. The admin UI hides the toggles, so
 *     only direct API callers hit this guard.
 */
import { type AuthSettings, adminAuthRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceBoolean, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:auth');

const KEY_REQUIRE_THIRD_PARTY_AUTH = 'auth:requireThirdPartyAuth';
const KEY_DISABLE_PASSWORD_AUTH = 'auth:disablePasswordAuth';

const readAuthSettings = (crowi: Crowi): AuthSettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    requireThirdPartyAuth: coerceBoolean(ns[KEY_REQUIRE_THIRD_PARTY_AUTH]),
    disablePasswordAuth: coerceBoolean(ns[KEY_DISABLE_PASSWORD_AUTH]),
  };
};

export const registerAdminAuthRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/auth/*', createJwtAdminRequired(crowi));
  app.use('/admin/auth', createJwtAdminRequired(crowi));

  return app
    .openapi(adminAuthRoutes.getAuthSettingsRoute, async (c) => {
      try {
        return c.json(readAuthSettings(crowi), 200);
      } catch (err) {
        debug('Error reading auth settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminAuthRoutes.updateAuthSettingsRoute, async (c) => {
      const body = c.req.valid('json');

      // Third-party (Google / GitHub) sign-in was removed from core in the
      // 2.0.0-alpha line, so `hasValidThirdPartyId()` is now permanently
      // false. Enabling either of these settings would lock every account out
      // of password login with no third-party recovery path. The config keys
      // and schema are kept (inert) for a future auth plugin, but the endpoint
      // hard-rejects turning them on so a direct API caller can't self-lock.
      // The admin UI hides both toggles, so the UI never reaches this branch.
      if (body.requireThirdPartyAuth || body.disablePasswordAuth) {
        return c.json(
          {
            error: {
              code: 'THIRD_PARTY_AUTH_UNAVAILABLE' as const,
              message:
                'Third-party sign-in was removed from core, so requireThirdPartyAuth and disablePasswordAuth cannot be enabled. They will return when an auth provider plugin is installed.',
            },
          },
          400,
        );
      }

      // Past the guard both toggles are guaranteed false, so this only ever
      // persists the (inert) disabled state.
      try {
        await crowi.getConfigService().saveConfig('crowi', {
          [KEY_REQUIRE_THIRD_PARTY_AUTH]: body.requireThirdPartyAuth,
          [KEY_DISABLE_PASSWORD_AUTH]: body.disablePasswordAuth,
        });
      } catch (err) {
        debug('Error saving auth settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      return c.json(readAuthSettings(crowi), 200);
    });
};
