import { z } from '@hono/zod-openapi';
import { PagerSchema, PageUserSchema, RevisionSchema } from './page';

/**
 * Revision meta schema - lightweight (no body) for list endpoints.
 *
 * Phase 8 (RFC-0003) added `savedBy` and `contributors`:
 *   - `savedBy` is the user who pressed the Save button (i.e. fired
 *     the `crowi:save` stateless message). In the legacy / v1.x
 *     single-author flow this is the same as `author`; in the
 *     collaborative flow it can differ from any single contributor.
 *   - `contributors` is the set of awareness-confirmed peers who had
 *     a live cursor on the page between the previous Save and this
 *     one. The list excludes `savedBy` itself (the save initiator is
 *     already surfaced separately) and is `undefined` for pre-RFC-0003
 *     revisions to keep wire-format back-compat.
 *
 * Both fields are optional + nullable so v1.x revisions can be served
 * without churn — clients that consume the new fields fall back to
 * `author` when `savedBy` is missing.
 */
export const RevisionMetaSchema = z.object({
  _id: z.string(),
  path: z.string(),
  author: PageUserSchema.nullable().optional(),
  savedBy: PageUserSchema.nullable().optional(),
  contributors: z.array(PageUserSchema).optional(),
  // RFC-0010 — edit channel. `web` (browser / collab editor) vs the API
  // token paths (`oauth` / `pat`). Absent on pre-RFC-0010 revisions. The
  // history UI shows an "app" chip for the token paths.
  editVia: z.enum(['web', 'oauth', 'pat']).optional(),
  createdAt: z.string(),
});
export type RevisionMeta = z.infer<typeof RevisionMetaSchema>;

// List revisions request schema (path param: page_id, query: limit/offset)
export const ListRevisionsRequestSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type ListRevisionsRequest = z.infer<typeof ListRevisionsRequestSchema>;

// List revisions response schema
export const ListRevisionsResponseSchema = z.object({
  revisions: z.array(RevisionMetaSchema),
  pager: PagerSchema,
});
export type ListRevisionsResponse = z.infer<typeof ListRevisionsResponseSchema>;

// Get single revision response schema
export const GetRevisionResponseSchema = z.object({
  revision: RevisionSchema,
});
export type GetRevisionResponse = z.infer<typeof GetRevisionResponseSchema>;

// Get multiple revisions request schema (query: ids comma-separated)
export const GetRevisionsRequestSchema = z.object({
  ids: z.string().min(1, 'ids is required'),
});
export type GetRevisionsRequest = z.infer<typeof GetRevisionsRequestSchema>;

// Get multiple revisions response schema
export const GetRevisionsResponseSchema = z.object({
  revisions: z.array(RevisionSchema),
});
export type GetRevisionsResponse = z.infer<typeof GetRevisionsResponseSchema>;

// Error schema for invalid request inputs (matches comment.ts shape)
export const RevisionInvalidRequestErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_REQUEST'),
    message: z.string(),
  }),
});
export type RevisionInvalidRequestError = z.infer<typeof RevisionInvalidRequestErrorSchema>;
