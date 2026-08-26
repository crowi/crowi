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
 *
 * NOTE: the legacy site-wide HTTP Basic auth (`security:basicName` /
 * `security:basicSecret`) was removed (breaking change). In the split
 * Next.js + Hono architecture, gate the site at a reverse proxy instead.
 * The old config keys, if present in the DB, are simply ignored.
 *
 * `linkCardEnabled` (feature-renderer-plugin-boundary Phase 3) controls
 * whether the core `@[card](url)` link-card embed is allowed to fetch
 * OGP metadata from external URLs. Missing / non-boolean stored values
 * read as `true` (default ON) — see
 * `packages/api/src/util/admin-config.ts`'s `coerceBoolean(value, true)`
 * call at every read site. Writing this field runs as its own
 * `ConfigService.saveConfigValue` call, BEFORE the batched write that
 * persists `registrationMode` / `registrationWhiteList`, so a failure
 * here short-circuits the whole PUT before any of it partially persists
 * — see `packages/api/src/hono/handlers/admin/security.ts`.
 */
export const SecuritySettingsSchema = z.object({
  registrationMode: RegistrationModeSchema,
  registrationWhiteList: z.array(z.string()),
  linkCardEnabled: z.boolean(),
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
