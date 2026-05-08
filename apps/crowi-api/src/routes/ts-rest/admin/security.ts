import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type RegistrationMode, type SecuritySettings } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { coerceString, coerceStringArray, getCrowiConfigNamespace } from 'src/util/admin-config';
import { internalServerErrorResponse } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:security');

/**
 * Default values for the security:* config keys, mirroring the legacy
 * `getArrayForInstalling` defaults in `apps/crowi-api/src/models/config.ts`.
 *
 * - basicName / basicSecret are not set on a fresh install -> empty string
 * - registrationMode defaults to 'Open'
 * - registrationWhiteList defaults to []
 *
 * The handler reads from `crowi.getConfig().crowi` which is populated from
 * Mongo on boot; if the keys are missing (e.g. older installs that pre-date
 * basic-auth support) we fall back to these defaults rather than 500ing.
 */
const DEFAULT_BASIC_NAME = '';
const DEFAULT_BASIC_SECRET = '';
const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'Open';

/**
 * Coerce an unknown config value to a RegistrationMode. Anything outside the
 * known enum is treated as the default ('Open') to avoid surfacing a 500 on
 * the GET endpoint when the database holds a stale or hand-edited value.
 */
const toRegistrationMode = (value: unknown): RegistrationMode => {
  if (value === 'Open' || value === 'Resricted' || value === 'Closed') {
    return value;
  }
  return DEFAULT_REGISTRATION_MODE;
};

/**
 * Trim each entry and drop empty strings. Mirrors the legacy
 * `stringToArrayFilter` semantics (after CRLF normalization), but applies
 * to an already-split array since the API contract requires string[].
 */
const sanitizeWhiteList = (list: string[]): string[] => {
  return list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
};

const readSecuritySettings = (crowi: Crowi): SecuritySettings => {
  const ns = getCrowiConfigNamespace(crowi);
  return {
    basicName: coerceString(ns['security:basicName'], DEFAULT_BASIC_NAME),
    basicSecret: coerceString(ns['security:basicSecret'], DEFAULT_BASIC_SECRET),
    registrationMode: toRegistrationMode(ns['security:registrationMode']),
    // coerceStringArray already returns [] when the value is missing — that doubles as the default.
    registrationWhiteList: coerceStringArray(ns['security:registrationWhiteList']),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const securityRouter = s.router(apiContract.admin.security, {
    /**
     * GET /api/v2/admin/security
     * Returns the four `security:*` config values currently in effect.
     * Authorization (jwt + admin) is handled by the surrounding adminRouter
     * middleware; missing/forbidden auth never reaches this handler.
     */
    getSecuritySettings: async () => {
      try {
        const settings = readSecuritySettings(crowi);
        return { status: 200 as const, body: settings };
      } catch (err) {
        const error = err as Error;
        debug('Error reading security settings:', error.message);
        return internalServerErrorResponse;
      }
    },

    /**
     * PUT /api/v2/admin/security
     * Persists the four `security:*` keys via configService.saveConfig('crowi', ...).
     *
     * - registrationWhiteList entries are trimmed and empty entries dropped,
     *   matching the legacy `normalizeCRLFFilter` + `stringToArrayFilter`
     *   behavior at the form layer.
     * - We only write the four security keys we own; saveConfig merges into
     *   the existing 'crowi' namespace so unrelated keys (app:*, mail:*,
     *   auth:*) are untouched.
     * - Returns the post-save settings so the UI doesn't need a follow-up GET.
     */
    updateSecuritySettings: async ({ body }) => {
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
        const error = err as Error;
        debug('Error saving security settings:', error.message);
        return internalServerErrorResponse;
      }

      // Re-read from the in-memory cache (saveConfig updates it) so the
      // response reflects the new values without a Mongo round-trip.
      return { status: 200 as const, body: readSecuritySettings(crowi) };
    },
  });

  createExpressEndpoints(apiContract.admin.security, securityRouter, router);

  return router;
};
