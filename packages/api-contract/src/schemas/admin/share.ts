import { z } from '@hono/zod-openapi';

/**
 * Canonical shape of the share-related admin settings on the wire.
 *
 * Mirrors the single legacy `app:externalShare` key in the `crowi` config
 * namespace. Renamed to `externalShare` at the API boundary to drop the
 * `app:` prefix that was an artefact of the underlying flat key/value store.
 *
 * The toggle controls whether share-link viewers (`/_share/:uuid`) and the
 * share CRUD endpoints (`/_api/shares.*`) are reachable at all; flipping it
 * off effectively disables external sharing site-wide. The detailed Share
 * UUID lifecycle (create/list/delete, secretKeyword, accesses.list) lives in
 * a separate contract namespace and is intentionally out of scope here.
 *
 * Keeping this as its own object (rather than a bare boolean) leaves room
 * for adding fields like `requireSecretKeyword` or `defaultExpiry` later
 * without breaking the wire format.
 */
export const ShareSettingsSchema = z.object({
  externalShare: z.boolean(),
});
export type ShareSettings = z.infer<typeof ShareSettingsSchema>;

/**
 * Request body for PUT /admin/share. Currently the same shape as the GET
 * response — the UI sends the full desired state, the server persists it.
 */
export const UpdateShareSettingsRequestSchema = ShareSettingsSchema;
export type UpdateShareSettingsRequest = z.infer<typeof UpdateShareSettingsRequestSchema>;

/**
 * Response shape for both GET /admin/share and PUT /admin/share.
 *
 * PUT returns the post-update settings (rather than `{ ok: true }`) so the UI
 * can reflect the persisted value (incl. any future server-side coercion)
 * without an extra round-trip.
 */
export const GetShareSettingsResponseSchema = ShareSettingsSchema;
export type GetShareSettingsResponse = z.infer<typeof GetShareSettingsResponseSchema>;

export const UpdateShareSettingsResponseSchema = ShareSettingsSchema;
export type UpdateShareSettingsResponse = z.infer<typeof UpdateShareSettingsResponseSchema>;
