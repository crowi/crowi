import { initContract } from '@ts-rest/core';
import {
  ListCommentsRequestSchema,
  ListCommentsResponseSchema,
  AddCommentRequestSchema,
  AddCommentResponseSchema,
  DeleteCommentRequestSchema,
  DeleteCommentResponseSchema,
  CommentNotFoundErrorSchema,
  CommentInvalidRequestErrorSchema,
} from '../schemas/comment';
import {
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
} from '../schemas/page';
import { AuthenticationRequiredErrorSchema } from '../schemas/common';

const c = initContract();

export const commentContract = c.router({
  /**
   * List comments by page_id or revision_id
   */
  listComments: {
    method: 'GET',
    path: '/comments',
    query: ListCommentsRequestSchema,
    responses: {
      200: ListCommentsResponseSchema,
      400: CommentInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'List comments by page or revision',
  },

  /**
   * Add a new comment to the given page revision
   */
  addComment: {
    method: 'POST',
    path: '/comments',
    body: AddCommentRequestSchema,
    responses: {
      200: AddCommentResponseSchema,
      400: CommentInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Add a comment to a page',
  },

  /**
   * Delete a comment by id (requires page grant)
   */
  deleteComment: {
    method: 'DELETE',
    path: '/comments',
    body: DeleteCommentRequestSchema,
    responses: {
      200: DeleteCommentResponseSchema,
      400: CommentInvalidRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: CommentNotFoundErrorSchema,
    },
    summary: 'Delete a comment',
  },
});
