import { z } from '@hono/zod-openapi';
import { PageUserSchema } from './page';

// Comment schema - matches CommentDocument shape, with creator populated
export const CommentSchema = z.object({
  _id: z.string(),
  page: z.string(),
  // creator is populated to a user object on the API side; allow string fallback for safety
  creator: z.union([z.string(), PageUserSchema]).nullable(),
  revision: z.string(),
  comment: z.string(),
  commentPosition: z.number().default(-1),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

// List comments request schema
// Either page_id or revision_id must be provided.
export const ListCommentsRequestSchema = z.object({
  page_id: z.string().optional(),
  revision_id: z.string().optional(),
});
export type ListCommentsRequest = z.infer<typeof ListCommentsRequestSchema>;

// List comments response schema
export const ListCommentsResponseSchema = z.object({
  comments: z.array(CommentSchema),
});
export type ListCommentsResponse = z.infer<typeof ListCommentsResponseSchema>;

// Add comment request schema
export const AddCommentRequestSchema = z.object({
  page_id: z.string().min(1, 'page_id is required'),
  revision_id: z.string().min(1, 'revision_id is required'),
  comment: z.string().min(1, 'comment is required'),
  comment_position: z.number().int().optional(),
});
export type AddCommentRequest = z.infer<typeof AddCommentRequestSchema>;

// Add comment response schema
export const AddCommentResponseSchema = z.object({
  comment: CommentSchema,
});
export type AddCommentResponse = z.infer<typeof AddCommentResponseSchema>;

// Delete comment request schema
export const DeleteCommentRequestSchema = z.object({
  comment_id: z.string().min(1, 'comment_id is required'),
  page_id: z.string().min(1, 'page_id is required'),
});
export type DeleteCommentRequest = z.infer<typeof DeleteCommentRequestSchema>;

// Delete comment response schema
export const DeleteCommentResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteCommentResponse = z.infer<typeof DeleteCommentResponseSchema>;

// Error response schemas
export const CommentNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.literal('COMMENT_NOT_FOUND'),
    message: z.literal('Comment not found'),
  }),
});

export const CommentInvalidRequestErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_REQUEST'),
    message: z.string(),
  }),
});

export type CommentNotFoundError = z.infer<typeof CommentNotFoundErrorSchema>;
export type CommentInvalidRequestError = z.infer<typeof CommentInvalidRequestErrorSchema>;
