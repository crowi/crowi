import { z } from '@hono/zod-openapi';

/**
 * Canonical shape of the authentication settings on the wire.
 *
 * Mirrors the two `auth:*` keys in the legacy `crowi` config namespace:
 *   - auth:requireThirdPartyAuth -> requireThirdPartyAuth
 *   - auth:disablePasswordAuth   -> disablePasswordAuth
 *
 * Both are simple booleans. The legacy form (`form/admin/auth.ts`) used
 * express-form `.toBoolean()` to coerce 'on' / 'true' style values; the new
 * API consumes JSON so callers must send proper booleans (z.boolean()).
 */
export const AuthSettingsSchema = z.object({
  requireThirdPartyAuth: z.boolean(),
  disablePasswordAuth: z.boolean(),
});
export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

/**
 * Request body for PUT /admin/auth.
 *
 * Strict booleans only — UIs that drive the toggles from a checkbox should
 * send `e.target.checked` directly. The server hard-rejects enabling either
 * toggle (see ThirdPartyAuthUnavailableErrorSchema) but the wire shape itself
 * is identical to the GET response.
 */
export const UpdateAuthSettingsRequestSchema = AuthSettingsSchema;
export type UpdateAuthSettingsRequest = z.infer<typeof UpdateAuthSettingsRequestSchema>;

/**
 * Response shape for both GET /admin/auth and PUT /admin/auth.
 *
 * PUT returns the post-update settings (rather than `{ ok: true }`) so the UI
 * can avoid an extra round-trip after saving — matches the admin/security
 * contract.
 */
export const GetAuthSettingsResponseSchema = AuthSettingsSchema;
export type GetAuthSettingsResponse = z.infer<typeof GetAuthSettingsResponseSchema>;

export const UpdateAuthSettingsResponseSchema = AuthSettingsSchema;
export type UpdateAuthSettingsResponse = z.infer<typeof UpdateAuthSettingsResponseSchema>;

/**
 * Returned (400) when the request tries to enable `requireThirdPartyAuth` or
 * `disablePasswordAuth`.
 *
 * Both settings depend on third-party (Google / GitHub) sign-in, which was
 * removed from core in the 2.0.0-alpha line — `User.hasValidThirdPartyId()` is
 * now permanently false, so enabling either would lock every account out of
 * password login with no third-party path to recover. The config keys and
 * schema are retained (inert) for a future auth plugin, but the endpoint hard-
 * rejects turning them on. The admin UI hides the toggles, so this guards the
 * API against direct callers.
 */
export const ThirdPartyAuthUnavailableErrorSchema = z.object({
  error: z.object({
    code: z.literal('THIRD_PARTY_AUTH_UNAVAILABLE'),
    message: z.string(),
  }),
});
export type ThirdPartyAuthUnavailableError = z.infer<typeof ThirdPartyAuthUnavailableErrorSchema>;
