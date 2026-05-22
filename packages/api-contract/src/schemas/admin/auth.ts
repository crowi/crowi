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
 * send `e.target.checked` directly. The server applies an extra guard for
 * `disablePasswordAuth: true` (see UpdateAuthSettings422Schema) but the wire
 * shape itself is identical to the GET response.
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
 * Surfaced when `disablePasswordAuth: true` is sent but the requesting admin
 * is not connected to a valid third-party identity (Google / GitHub). Mirrors
 * the legacy guard in `controllers/admin.ts:postSettings`:
 *
 *   if (form['auth:disablePasswordAuth'] && !user.hasValidThirdPartyId())
 *     return error('パスワードによるログインを禁止するには管理者が有効な
 *                   外部サービスと連携している必要があります。');
 *
 * The new API returns 422 with a discriminator code so the UI can surface the
 * exact failure mode independently of the (localised) message string.
 */
export const AuthSettingsValidationErrorSchema = z.object({
  error: z.object({
    code: z.literal('PASSWORD_AUTH_REQUIRES_THIRDPARTY'),
    message: z.string(),
  }),
});
export type AuthSettingsValidationError = z.infer<typeof AuthSettingsValidationErrorSchema>;
