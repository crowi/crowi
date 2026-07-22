/**
 * RFC-0006 Phase 4 Batch 9 — `admin.security` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/security.ts`. Two
 * admin-only endpoints:
 *
 *   GET /admin/security   — read the security:* keys
 *   PUT /admin/security   — persist them
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/security/*` + the bare `/admin/security` path.
 *
 * feature-renderer-plugin-boundary Phase 3 adds `linkCardEnabled`
 * (`security:linkCardEnabled`). Its PUT write is deliberately routed
 * through a SEPARATE, fail-propagating persistence call
 * (`ConfigService.saveConfigValueDurable`) rather than the existing
 * best-effort batched `saveConfig('crowi', {...})` call that
 * `registrationMode` / `registrationWhiteList` still use — see spec
 * §6.2. The durable write runs FIRST: if it fails, the handler 500s
 * immediately and the registration-settings batch write never runs
 * either, so a single PUT never partially persists.
 */
import { type RegistrationMode, type SecuritySettings, adminSecurityRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceBoolean, coerceStringArray, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:security');

const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'Open';

const toRegistrationMode = (value: unknown): RegistrationMode => {
  if (value === 'Open' || value === 'Resricted' || value === 'Closed') return value;
  return DEFAULT_REGISTRATION_MODE;
};

const sanitizeWhiteList = (list: string[]): string[] => list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);

const readSecuritySettings = (crowi: Crowi): SecuritySettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    registrationMode: toRegistrationMode(ns['security:registrationMode']),
    registrationWhiteList: coerceStringArray(ns['security:registrationWhiteList']),
    // Missing row / hand-edited non-boolean value both collapse to
    // enabled (default-on) — spec §6.2's exact rationale as
    // `app.ts`'s capability probe and `renderer/index.ts`'s live
    // per-dispatch read.
    linkCardEnabled: coerceBoolean(ns['security:linkCardEnabled'], true),
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

      try {
        await configService.saveConfigValueDurable('crowi', 'security:linkCardEnabled', body.linkCardEnabled);
      } catch (err) {
        debug('Error durably saving security:linkCardEnabled:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      const sanitizedWhiteList = sanitizeWhiteList(body.registrationWhiteList);
      try {
        await configService.saveConfig('crowi', {
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
