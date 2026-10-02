import { z } from '@hono/zod-openapi';

import { ARTIFACT_LINK_MAX_LENGTH } from '../util/artifact-link';
import { ApiErrorSchema } from './common';

// `.strict()` rejects unknown fields to prevent client confusion
// if new parameters are added in the future.
export const MintArtifactUrlRequestSchema = z
  .object({
    revisionId: z.string().optional(),
  })
  .strict();
export type MintArtifactUrlRequest = z.infer<typeof MintArtifactUrlRequestSchema>;

/**
 * `type` of the `{ type, height }` message the frame bridge (the script the
 * delivery route appends to a served artifact) posts to the wiki page
 * embedding it, so the page can size the frame to the artifact's content
 * height.
 */
export const ARTIFACT_HEIGHT_MESSAGE_TYPE = 'crowi:artifact-height';

/**
 * `type` of the `{ type }` message the frame bridge posts when Escape is
 * pressed inside the artifact and the artifact did not handle it; key events
 * inside the cross-origin frame never reach the page's own listeners.
 */
export const ARTIFACT_ESCAPE_MESSAGE_TYPE = 'crowi:artifact-escape';

/**
 * `type` of the `{ type, href, disposition }` message the frame bridge posts
 * when the reader activates a page link inside the artifact. `href` is the raw
 * attribute value; the wiki page parses and authorizes it before navigating.
 */
export const ARTIFACT_NAVIGATE_MESSAGE_TYPE = 'crowi:artifact-navigate';

export const ArtifactNavigateMessageSchema = z
  .object({
    type: z.literal(ARTIFACT_NAVIGATE_MESSAGE_TYPE),
    href: z.string().min(1).max(ARTIFACT_LINK_MAX_LENGTH),
    disposition: z.enum(['same-tab', 'new-tab']),
  })
  .strict();
export type ArtifactNavigateMessage = z.infer<typeof ArtifactNavigateMessageSchema>;

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
