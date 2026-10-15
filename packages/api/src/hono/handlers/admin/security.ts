/**
 * `admin.security` resource: two admin-only endpoints.
 *
 *   GET /admin/security   — read the security:* settings
 *   PUT /admin/security   — persist the fields present in the body
 *
 * Auth: admin-only via broad `createJwtAdminRequired(crowi)` apply on
 * `/admin/security/*` + the bare `/admin/security` path.
 *
 * PUT is a partial update: only fields the body carries (`false` and `[]`
 * included) are written, in a fixed order — `linkCardEnabled`, the batched
 * registration keys, then `htmlSanitizationEnabled`. The saves are not one
 * transaction: a failure returns 500 but earlier saves stay persisted, and a
 * failure at one stage prevents the later stages from running. `{}` writes
 * nothing and notifies nobody.
 */
import type { SecuritySettings } from '@crowi/api-contract';
import { adminSecurityRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceStringArray, getCrowiConfigNamespace, isHtmlSanitizationEnabled, isLinkCardEnabled, readRegistrationMode } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:security');

const sanitizeWhiteList = (list: string[]): string[] => list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);

const readSecuritySettings = (crowi: Crowi): SecuritySettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    registrationMode: readRegistrationMode(crowi),
    registrationWhiteList: coerceStringArray(ns['security:registrationWhiteList']),
    // `isLinkCardEnabled` is the single source of truth for the
    // default-on-missing/non-boolean fallback — shared with `app.ts`'s
    // capability probe and `renderer/index.ts`'s live per-dispatch read.
    linkCardEnabled: isLinkCardEnabled(crowi),
    htmlSanitizationEnabled: isHtmlSanitizationEnabled(crowi),
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
        if (body.linkCardEnabled !== undefined) {
          await configService.saveConfigValue('crowi', 'security:linkCardEnabled', body.linkCardEnabled);
        }

        const registration: Record<string, unknown> = {};
        if (body.registrationMode !== undefined) registration['security:registrationMode'] = body.registrationMode;
        if (body.registrationWhiteList !== undefined) registration['security:registrationWhiteList'] = sanitizeWhiteList(body.registrationWhiteList);
        if (Object.keys(registration).length > 0) {
          await configService.saveConfig('crowi', registration);
        }

        if (body.htmlSanitizationEnabled !== undefined) {
          await configService.saveConfigValue('crowi', 'security:htmlSanitizationEnabled', body.htmlSanitizationEnabled);
        }
      } catch (err) {
        debug('Error saving security settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      return c.json(readSecuritySettings(crowi), 200);
    });
};
