/**
 * RFC-0006 Phase 4 Batch 3 — `comment` resource ported to
 * `@hono/zod-openapi` route definitions. Three endpoints:
 *
 *   GET    /comments — list comments by page_id or revision_id
 *   POST   /comments — add a comment to a page revision
 *   DELETE /comments — delete a comment by id (requires page grant)
 *
 * All endpoints require JWT authentication. The Hono handler applies
 * `createJwtAuth(crowi)` broadly to `/comments/*` so `c.get('user')`
 * is populated for every handler. Error envelopes are preserved from
 * the ts-rest era so the web client sees identical bodies.
 */
import { createRoute } from '@hono/zod-openapi';

import {
  AddCommentRequestSchema,
  AddCommentResponseSchema,
  CommentInvalidRequestErrorSchema,
  CommentNotFoundErrorSchema,
  DeleteCommentRequestSchema,
  DeleteCommentResponseSchema,
  ListCommentsRequestSchema,
  ListCommentsResponseSchema,
} from '../schemas/comment';
import { AuthenticationRequiredErrorSchema } from '../schemas/common';
import { PageNotFoundErrorSchema, PageNotGrantedErrorSchema } from '../schemas/page';

export const listCommentsRoute = createRoute({
  method: 'get',
  path: '/comments',
  tags: ['comment'],
  security: [{ bearerAuth: [] }],
  summary: 'List comments by page or revision',
  request: {
    query: ListCommentsRequestSchema,
  },
  responses: {
    200: {
      description: 'Comments matching the requested page or revision',
      content: { 'application/json': { schema: ListCommentsResponseSchema } },
    },
    400: {
      description: 'Invalid request (page_id / revision_id required or malformed)',
      content: { 'application/json': { schema: CommentInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const addCommentRoute = createRoute({
  method: 'post',
  path: '/comments',
  tags: ['comment'],
  security: [{ bearerAuth: [] }],
  summary: 'Add a comment to a page',
  request: {
    body: {
      content: { 'application/json': { schema: AddCommentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The created comment with populated creator',
      content: { 'application/json': { schema: AddCommentResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: CommentInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied to avoid leaking existence)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const deleteCommentRoute = createRoute({
  method: 'delete',
  path: '/comments',
  tags: ['comment'],
  security: [{ bearerAuth: [] }],
  summary: 'Delete a comment',
  request: {
    body: {
      content: { 'application/json': { schema: DeleteCommentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Comment removed',
      content: { 'application/json': { schema: DeleteCommentResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: CommentInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Caller cannot access the parent page',
      content: { 'application/json': { schema: PageNotGrantedErrorSchema } },
    },
    404: {
      description: 'Comment not found',
      content: { 'application/json': { schema: CommentNotFoundErrorSchema } },
    },
  },
});

export const commentRoutes = {
  listCommentsRoute,
  addCommentRoute,
  deleteCommentRoute,
};
