import { z } from '@hono/zod-openapi';
import { ApiErrorSchema } from '../common';

/**
 * `maxBytes` range for the admin `settings.maxBytes` field. Mirrors
 * `packages/api/src/artifact/constants.ts`'s `ARTIFACT_MIN_MAX_BYTES` /
 * `ARTIFACT_HARD_MAX_BYTES` — `api-contract` cannot import `api`, so these
 * are a deliberate literal duplicate; `admin/artifact.test.ts` asserts the
 * two pairs stay equal.
 */
export const ARTIFACT_MAX_BYTES_MIN = 64 * 1024;
export const ARTIFACT_MAX_BYTES_MAX = 10 * 1024 * 1024;

/**
 * Effective artifact delivery mode (`ArtifactPolicySnapshot.deliveryMode`,
 * `packages/api/src/artifact/policy.ts`'s §R 表).
 */
export const ArtifactDeliveryModeSchema = z.enum(['separate-origin', 'same-origin', 'disabled']);
export type ArtifactDeliveryMode = z.infer<typeof ArtifactDeliveryModeSchema>;

/** Why the stored same-origin toggle is not the active mode right now (§R 表). */
export const ArtifactSameOriginInactiveReasonSchema = z.enum(['separate-origin-active', 'client-url-unset']);
export type ArtifactSameOriginInactiveReason = z.infer<typeof ArtifactSameOriginInactiveReasonSchema>;

/** The 3 stored `artifact:policy` fields (§K-1 / §C 表). */
export const ArtifactSettingsSchema = z.object({
  sameOriginEnabled: z.boolean(),
  allowWebFonts: z.boolean(),
  maxBytes: z.number().int().min(ARTIFACT_MAX_BYTES_MIN).max(ARTIFACT_MAX_BYTES_MAX),
});
export type ArtifactSettings = z.infer<typeof ArtifactSettingsSchema>;

/**
 * Response shape for both GET and PUT `/admin/artifact` (§A-3). Effective
 * values (`deliveryMode` / `artifactOrigin` / `crowiOrigin` / `writeEnabled`
 * / `sameOriginInactiveReason`) come from the R table; `settings` is the
 * stored value read via the C table.
 */
export const GetArtifactSettingsResponseSchema = z.object({
  deliveryMode: ArtifactDeliveryModeSchema,
  artifactOrigin: z.string().nullable(),
  crowiOrigin: z.string().nullable(),
  writeEnabled: z.boolean(),
  sameOriginInactiveReason: ArtifactSameOriginInactiveReasonSchema.nullable(),
  settings: ArtifactSettingsSchema,
});
export type GetArtifactSettingsResponse = z.infer<typeof GetArtifactSettingsResponseSchema>;

/** Request body for PUT `/admin/artifact` (§A-2) — all 3 fields required, no extra keys. */
export const UpdateArtifactSettingsRequestSchema = ArtifactSettingsSchema.strict();
export type UpdateArtifactSettingsRequest = z.infer<typeof UpdateArtifactSettingsRequestSchema>;

export const UpdateArtifactSettingsResponseSchema = GetArtifactSettingsResponseSchema;
export type UpdateArtifactSettingsResponse = z.infer<typeof UpdateArtifactSettingsResponseSchema>;

/**
 * 400 returned by PUT `/admin/artifact` when `sameOriginEnabled: true` is
 * requested but no `CLIENT_URL` is configured to serve same-origin delivery
 * under (§A-4). Never persisted — the handler rejects before touching the DB.
 */
export const ArtifactSettingsRejectedErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('ARTIFACT_SETTINGS_REJECTED'),
    message: z.string(),
    reason: z.literal('CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN'),
  }),
});
export type ArtifactSettingsRejectedError = z.infer<typeof ArtifactSettingsRejectedErrorSchema>;
