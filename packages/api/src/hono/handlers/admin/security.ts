/**
 * RFC-0006 Phase 4 Batch 9 — `admin.security` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/security.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/security   — read the four `security:*` keys
 *   PUT /admin/security   — persist them
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/security/*` + the bare `/admin/security` path.
 */
import { type RegistrationMode, type SecuritySettings, adminSecurityRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceString, coerceStringArray, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:security');

const DEFAULT_BASIC_NAME = '';
const DEFAULT_BASIC_SECRET = '';
const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'Open';

const toRegistrationMode = (value: unknown): RegistrationMode => {
  if (value === 'Open' || value === 'Resricted' || value === 'Closed') return value;
  return DEFAULT_REGISTRATION_MODE;
};

const sanitizeWhiteList = (list: string[]): string[] => list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);

const readSecuritySettings = (crowi: Crowi): SecuritySettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    basicName: coerceString(ns['security:basicName'], DEFAULT_BASIC_NAME),
    basicSecret: coerceString(ns['security:basicSecret'], DEFAULT_BASIC_SECRET),
    registrationMode: toRegistrationMode(ns['security:registrationMode']),
    registrationWhiteList: coerceStringArray(ns['security:registrationWhiteList']),
  };
};

export const registerAdminSecurityRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/security/*', createJwtAdminRequired(crowi));
  app.use('/admin/security', createJwtAdminRequired(crowi));

  return app
    .openapi(adminSecurityRoutes.getSecuritySettingsRoute, async (c) => {
      try {
        return c.json(readSecuritySettings(crowi), 200);
      } catch (err) {
        debug('Error reading security settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminSecurityRoutes.updateSecuritySettingsRoute, async (c) => {
      const body = c.req.valid('json');
      const configService = crowi.getConfigService();
      const sanitizedWhiteList = sanitizeWhiteList(body.registrationWhiteList);

      try {
        await configService.saveConfig('crowi', {
          'security:basicName': body.basicName,
          'security:basicSecret': body.basicSecret,
          'security:registrationMode': body.registrationMode,
          'security:registrationWhiteList': sanitizedWhiteList,
        });
      } catch (err) {
        debug('Error saving security settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      return c.json(readSecuritySettings(crowi), 200);
    });
};
