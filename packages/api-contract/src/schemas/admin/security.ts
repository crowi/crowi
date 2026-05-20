import { z } from '@hono/zod-openapi';

/**
 * Registration mode enum.
 *
 * NOTE: 'Resricted' is intentionally a typo (sic) — it matches the historical
 * value persisted in the `crowi.security:registrationMode` config key. Renaming
 * to 'Restricted' would require a separate data migration task. For now we
 * preserve backward compatibility and accept the misspelled value at the API
 * boundary. UIs can present 'Restricted' to users while sending 'Resricted'
 * over the wire.
 *
 * See: packages/api/src/models/config.ts (SECURITY_REGISTRATION_MODE_RESTRICTED)
 */
export const RegistrationModeSchema = z.enum(['Open', 'Resricted', 'Closed']);
export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;

/**
 * Canonical shape of the security settings on the wire.
 *
 * Mirrors the four `security:*` keys in the legacy `crowi` config namespace:
 *   - security:basicName              -> basicName
 *   - security:basicSecret            -> basicSecret  (returned in plaintext, see openQuestions)
 *   - security:registrationMode       -> registrationMode
 *   - security:registrationWhiteList  -> registrationWhiteList
 *
 * basicSecret is currently returned as plaintext to preserve parity with the
 * legacy `actions.api.app.index` endpoint. Migrating to a write-only / masked
 * representation is tracked in openQuestions.
 */
export const SecuritySettingsSchema = z.object({
  basicName: z.string(),
  basicSecret: z.string(),
  registrationMode: RegistrationModeSchema,
  registrationWhiteList: z.array(z.string()),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/**
 * Request body for PUT /admin/security.
 *
 * The contract accepts `registrationWhiteList` strictly as `string[]`. UIs that
 * present the list as a textarea should split on newlines and trim/filter
 * empty lines before sending. The server still defensively trims and drops
 * empty entries to mirror the legacy `stringToArrayFilter` behavior.
 */
export const UpdateSecuritySettingsRequestSchema = SecuritySettingsSchema;
export type UpdateSecuritySettingsRequest = z.infer<typeof UpdateSecuritySettingsRequestSchema>;

/**
 * Response shape for both GET /admin/security and PUT /admin/security.
 *
 * PUT returns the post-update settings (rather than `{ ok: true }`) so the UI
 * can avoid an extra round-trip after saving.
 */
export const GetSecuritySettingsResponseSchema = SecuritySettingsSchema;
export type GetSecuritySettingsResponse = z.infer<typeof GetSecuritySettingsResponseSchema>;

export const UpdateSecuritySettingsResponseSchema = SecuritySettingsSchema;
export type UpdateSecuritySettingsResponse = z.infer<typeof UpdateSecuritySettingsResponseSchema>;
