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
 * Mirrors the registration-related `security:*` keys in the `crowi` config
 * namespace:
 *   - security:registrationMode       -> registrationMode
 *   - security:registrationWhiteList  -> registrationWhiteList
 *   - security:linkCardEnabled        -> linkCardEnabled
 *   - security:htmlSanitizationEnabled -> htmlSanitizationEnabled
 *
 * NOTE: the legacy site-wide HTTP Basic auth (`security:basicName` /
 * `security:basicSecret`) was removed (breaking change). In the split
 * Next.js + Hono architecture, gate the site at a reverse proxy instead.
 * The old config keys, if present in the DB, are simply ignored.
 *
 * `linkCardEnabled` controls whether the core `@[card](url)` link-card embed
 * may fetch OGP metadata from external URLs. `htmlSanitizationEnabled`
 * controls whether Markdown HTML is displayed with the strict sanitizer (ON,
 * the default) or the relaxed one (OFF). For both, a missing / non-boolean
 * stored value reads as `true`.
 *
 * Every field of the response is always present: the server returns the
 * effective settings, not an echo of the request.
 */
export const SecuritySettingsSchema = z.object({
  registrationMode: RegistrationModeSchema,
  registrationWhiteList: z.array(z.string()),
  linkCardEnabled: z.boolean(),
  htmlSanitizationEnabled: z.boolean(),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/**
 * Request body for PUT /admin/security.
 *
 * Every field is optional and only the fields present are written; an omitted
 * field keeps its stored value (no default is saved). `{}` is a no-op that
 * returns the current settings. `registrationWhiteList` is a strict
 * `string[]` (`[]` clears the list); the server trims entries and drops empty
 * ones to mirror the legacy `stringToArrayFilter` behavior.
 */
export const UpdateSecuritySettingsRequestSchema = SecuritySettingsSchema.partial();
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
