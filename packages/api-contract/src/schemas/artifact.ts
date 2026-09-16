import { z } from '@hono/zod-openapi';

import { ApiErrorSchema } from './common';

// `.strict()` rejects unknown fields to prevent client confusion
// if new parameters are added in the future.
export const MintArtifactUrlRequestSchema = z
  .object({
    revisionId: z.string().optional(),
  })
  .strict();
export type MintArtifactUrlRequest = z.infer<typeof MintArtifactUrlRequestSchema>;

export const MintArtifactUrlResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
});
export type MintArtifactUrlResponse = z.infer<typeof MintArtifactUrlResponseSchema>;

// Separate error union from ingest rejections; delivery failures
// need their own client-facing distinction.
const ArtifactUrlErrorReasonSchema = z.enum(['NOT_AN_ARTIFACT', 'ARTIFACT_DELIVERY_NOT_CONFIGURED']);

export const ArtifactUrlUnavailableErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('ARTIFACT_URL_UNAVAILABLE'),
    reason: ArtifactUrlErrorReasonSchema,
    message: z.string(),
  }),
});
export type ArtifactUrlUnavailableError = z.infer<typeof ArtifactUrlUnavailableErrorSchema>;
