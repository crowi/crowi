import { z } from 'zod';
import { PagerSchema, PageUserSchema, RevisionSchema } from './page';

// Revision meta schema - lightweight (no body) for list endpoints
export const RevisionMetaSchema = z.object({
  _id: z.string(),
  path: z.string(),
  author: PageUserSchema.nullable().optional(),
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
