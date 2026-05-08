import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type AuthSettings } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:auth');

/**
 * Default values for the two auth:* config keys, mirroring the
 * `getArrayForInstalling` defaults in `apps/crowi-api/src/models/config.ts`:
 *
 *   'auth:requireThirdPartyAuth': false,
 *   'auth:disablePasswordAuth':   false,
 *
 * If the keys are missing from the in-memory config (e.g. older installs
 * predating these settings) we fall back to false rather than 500ing.
 */
const KEY_REQUIRE_THIRD_PARTY_AUTH = 'auth:requireThirdPartyAuth';
const KEY_DISABLE_PASSWORD_AUTH = 'auth:disablePasswordAuth';
const DEFAULT_REQUIRE_THIRD_PARTY_AUTH = false;
const DEFAULT_DISABLE_PASSWORD_AUTH = false;

/**
 * Coerce an unknown config value to a boolean. Stored Config values are
 * JSON-parsed at load time (see ConfigModel.loadAllConfig), so for boolean
 * keys we typically already get a boolean. Defensively map non-boolean
 * values back to the provided fallback.
 */
const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  return fallback;
};

const readAuthSettings = (crowi: Crowi): AuthSettings => {
  const cfg = crowi.getConfig();
  const ns = (cfg && typeof cfg === 'object' ? (cfg as { crowi?: Record<string, unknown> }).crowi : undefined) ?? {};

  return {
    requireThirdPartyAuth: toBoolean(ns[KEY_REQUIRE_THIRD_PARTY_AUTH], DEFAULT_REQUIRE_THIRD_PARTY_AUTH),
    disablePasswordAuth: toBoolean(ns[KEY_DISABLE_PASSWORD_AUTH], DEFAULT_DISABLE_PASSWORD_AUTH),
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const authRouter = s.router(apiContract.admin.auth, {
    /**
     * GET /api/v2/admin/auth
     * Returns the two `auth:*` config values currently in effect.
     * Authorization (jwt + admin) is handled by the surrounding adminRouter
     * middleware; missing/forbidden auth never reaches this handler.
     */
    getAuthSettings: async () => {
      try {
        const settings = readAuthSettings(crowi);
        return { status: 200 as const, body: settings };
      } catch (err) {
        const error = err as Error;
        debug('Error reading auth settings:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * PUT /api/v2/admin/auth
     * Persists the two `auth:*` keys via configService.saveConfig('crowi', ...).
     *
     * Self-lockout guard: if the requester sets `disablePasswordAuth: true`
     * but their own account is not connected to a valid third-party identity
     * (Google / GitHub), reject with 422. Mirrors the legacy guard in
     * controllers/admin.ts:postSettings — it intentionally checks only the
     * acting admin, not other admins, matching the previous behaviour.
     *
     * - We only write the two auth keys we own; saveConfig merges into the
     *   existing 'crowi' namespace so unrelated keys (app:*, security:*,
     *   mail:*) are untouched.
     * - Returns the post-save settings so the UI doesn't need a follow-up GET.
     */
    updateAuthSettings: async ({ body, req }) => {
      // jwtAdminRequired guarantees req.user is populated; the augmentation
      // declares it optional so we re-narrow here.
      const user = req.user as UserDocument;

      if (body.disablePasswordAuth && !user.hasValidThirdPartyId()) {
        return {
          status: 422 as const,
          body: {
            error: {
              code: 'PASSWORD_AUTH_REQUIRES_THIRDPARTY' as const,
              // Wire-level fallback; UIs key off `code` and render the
              // localised message via paraglide. Kept non-empty so legacy
              // / scripted callers see a hint without grepping for the code.
              message: 'Disabling password auth requires the acting admin to be connected to a valid third-party identity.',
            },
          },
        };
      }

      try {
        await crowi.getConfigService().saveConfig('crowi', {
          [KEY_REQUIRE_THIRD_PARTY_AUTH]: body.requireThirdPartyAuth,
          [KEY_DISABLE_PASSWORD_AUTH]: body.disablePasswordAuth,
        });
      } catch (err) {
        const error = err as Error;
        debug('Error saving auth settings:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }

      // Re-read from the in-memory cache (saveConfig updates it) so the
      // response reflects the new values without a Mongo round-trip.
      return { status: 200 as const, body: readAuthSettings(crowi) };
    },
  });

  createExpressEndpoints(apiContract.admin.auth, authRouter, router);

  return router;
};
