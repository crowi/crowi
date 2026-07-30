import { z } from '@hono/zod-openapi';
import { RenderedAstArtifactKeySchema, RenderedAstValueSchema } from './rendered-ast';

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
 * revision (RFC-0023): the same envelope-or-bare-Root union as
 * `RevisionSchema.renderedAst` — preview does NOT go through
 * `RevisionSchema`, so it must carry the union independently or the
 * declared-client (v1) preview response would never surface in the
 * contract types. `renderedAstArtifactKey` is a per-response nonce
 * here (preview output is never a stored artifact).
 */
export const PreviewPageResponseSchema = z.object({
  renderedAst: RenderedAstValueSchema.optional(),
  renderedAstArtifactKey: RenderedAstArtifactKeySchema.optional(),
});
export type PreviewPageResponse = z.infer<typeof PreviewPageResponseSchema>;
