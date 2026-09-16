/**
 * feature-html-artifact-delivery-policy §A 表 — `admin.artifact` resource.
 *
 *   GET /admin/artifact  — effective delivery mode + stored settings
 *   PUT /admin/artifact  — persist sameOriginEnabled / allowWebFonts / maxBytes
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/artifact/*` + the bare `/admin/artifact` path, same as
 *     `admin.security`.
 */
import { adminArtifactRoutes, type GetArtifactSettingsResponse } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import { ARTIFACT_ADMIN_SAME_ORIGIN_REQUIRES_CLIENT_URL_MESSAGE, ARTIFACT_CONFIG_NAMESPACE, ARTIFACT_POLICY_KEY } from 'src/artifact/config';
import { resolveArtifactPolicyState } from 'src/artifact/policy';
import type Crowi from 'src/crowi';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:artifact');

/** §A-3 — builds the GET / PUT response shape from the resolved policy state (R 表 + C 表). */
export const readArtifactSettingsResponse = (crowi: Crowi): GetArtifactSettingsResponse => {
  const { snapshot, settings, sameOriginInactiveReason } = resolveArtifactPolicyState(crowi);
  return {
    deliveryMode: snapshot.deliveryMode,
    artifactOrigin: snapshot.artifactOrigin,
    crowiOrigin: snapshot.crowiOrigin,
    writeEnabled: snapshot.writeEnabled,
    sameOriginInactiveReason,
    settings,
  };
};

export const registerAdminArtifactRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/artifact/*', createJwtAdminRequired(crowi));
  app.use('/admin/artifact', createJwtAdminRequired(crowi));

  return app
    .openapi(adminArtifactRoutes.getArtifactSettingsRoute, async (c) => {
      try {
        return c.json(readArtifactSettingsResponse(crowi), 200);
      } catch (err) {
        debug('Error reading artifact settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminArtifactRoutes.updateArtifactSettingsRoute, async (c) => {
      const body = c.req.valid('json');

      // §A-4 — a same-origin toggle with no CLIENT_URL is rejected BEFORE
      // touching the DB; disabling (`sameOriginEnabled: false`) is never
      // rejected, and Mode A being active does not block the stored value
      // either (it simply stays inactive — R-1 always wins).
      if (body.sameOriginEnabled && crowi.getArtifactDeliveryEnv().crowiOrigin === null) {
        return c.json(
          {
            error: {
              code: 'ARTIFACT_SETTINGS_REJECTED' as const,
              reason: 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN' as const,
              message: ARTIFACT_ADMIN_SAME_ORIGIN_REQUIRES_CLIENT_URL_MESSAGE,
            },
          },
          400,
        );
      }

      try {
        // §A-5 — a single key holding the object value: `updateConfigByNamespace`
        // writes it via one `findOneAndUpdate`, so there is no partial
        // persistence across the 3 fields to guard against.
        await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
          [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: body.sameOriginEnabled, allowWebFonts: body.allowWebFonts, maxBytes: body.maxBytes },
        });
      } catch (err) {
        debug('Error saving artifact settings:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      return c.json(readArtifactSettingsResponse(crowi), 200);
    });
};
