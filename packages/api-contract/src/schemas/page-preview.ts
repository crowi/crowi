import { z } from '@hono/zod-openapi';

/**
 * Request body for POST /pages/preview. Just the raw markdown body —
 * we deliberately do NOT take a page id / revision id here, because
 * the editor preview pane needs to render arbitrary in-flight text
 * that may not (yet) belong to a persisted revision.
 */
export const PreviewPageRequestSchema = z.object({
  body: z.string(),
});
export type PreviewPageRequest = z.infer<typeof PreviewPageRequestSchema>;

/**
 * Response shape mirrors the `renderedAst` carried on a populated
 * revision. We keep it as `z.unknown()` (same temperature as
 * `RevisionSchema.renderedAst`) because the persisted mdast shape is
 * external-spec / too deep to maintain a strict Zod schema for; the
 * client casts to `mdast.Root` at the boundary.
 */
export const PreviewPageResponseSchema = z.object({
  renderedAst: z.unknown(),
});
export type PreviewPageResponse = z.infer<typeof PreviewPageResponseSchema>;
