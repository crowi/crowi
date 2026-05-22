/**
 * RFC-0006 Phase 4 Batch 9 — `admin.auth` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/auth.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/auth   — read the two `auth:*` settings
 *   PUT /admin/auth   — persist them (with self-lockout 422 guard)
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/auth/*` + the bare `/admin/auth` path.
 *
 * Self-lockout guard:
 *   - When the requester sets `disablePasswordAuth: true` without a
 *     valid third-party identity, return 422
 *     `PASSWORD_AUTH_REQUIRES_THIRDPARTY` (legacy parity, byte-identical).
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
      const user = c.get('user');

      if (body.disablePasswordAuth && !user.hasValidThirdPartyId()) {
        return c.json(
          {
            error: {
              code: 'PASSWORD_AUTH_REQUIRES_THIRDPARTY' as const,
              message: 'Disabling password auth requires the acting admin to be connected to a valid third-party identity.',
            },
          },
          422,
        );
      }

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
