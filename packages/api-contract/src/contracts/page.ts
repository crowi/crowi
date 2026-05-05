import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  GetPageRequestSchema,
  GetPageResponseSchema,
  ListPagesRequestSchema,
  ListPagesResponseSchema,
  CreatePageRequestSchema,
  UpdatePageRequestSchema,
  RenamePageRequestSchema,
  PageSchema,
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
  PageRevisionErrorSchema,
} from '../schemas/page';
import { AuthenticationRequiredErrorSchema } from '../schemas/common';

const c = initContract();

export const pageContract = c.router({
  /**
   * Get page data
   * - Supports both path and page_id
   * - Optional revision_id for historical revisions
   */
  getPage: {
    method: 'GET',
    path: '/pages',
    query: GetPageRequestSchema,
    responses: {
      200: GetPageResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Get page data',
  },

  /**
   * List pages by path or user
   * - Supports pagination with limit and offset
   */
  listPages: {
    method: 'GET',
    path: '/pages/list',
    query: ListPagesRequestSchema,
    responses: {
      200: ListPagesResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'List pages by path or user',
  },

  /**
   * Create new page
   */
  createPage: {
    method: 'POST',
    path: '/pages',
    body: CreatePageRequestSchema,
    responses: {
      200: z.object({ page: PageSchema }),
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Create new page',
  },

  /**
   * Update existing page
   */
  updatePage: {
    method: 'PUT',
    path: '/pages',
    body: UpdatePageRequestSchema,
    responses: {
      200: z.object({ page: PageSchema }),
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
      409: PageRevisionErrorSchema,
    },
    summary: 'Update existing page',
  },

  /**
   * Mark page as seen by current user
   */
  seenPage: {
    method: 'POST',
    path: '/pages/seen',
    body: z.object({ page_id: z.string() }),
    responses: {
      200: z.object({ seenUser: z.any() }),
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Mark page as seen',
  },

  /**
   * Like a page
   */
  likePage: {
    method: 'POST',
    path: '/pages/like',
    body: z.object({ page_id: z.string() }),
    responses: {
      200: z.object({ page: PageSchema }),
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Like a page',
  },

  /**
   * Unlike a page
   */
  unlikePage: {
    method: 'POST',
    path: '/pages/unlike',
    body: z.object({ page_id: z.string() }),
    responses: {
      200: z.object({ page: PageSchema }),
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Unlike a page',
  },

  /**
   * Delete page (soft delete - moves to trash)
   */
  deletePage: {
    method: 'DELETE',
    path: '/pages',
    body: z.object({
      page_id: z.string(),
      revision_id: z.string().optional(),
      completely: z.boolean().optional(),
    }),
    responses: {
      200: z.object({ page: PageSchema }),
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
      409: PageRevisionErrorSchema,
    },
    summary: 'Delete page',
  },

  /**
   * Revert deleted page
   */
  revertDeletedPage: {
    method: 'POST',
    path: '/pages/revert',
    body: z.object({ page_id: z.string() }),
    responses: {
      200: z.object({ page: PageSchema }),
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Revert deleted page',
  },

  /**
   * Rename page
   */
  renamePage: {
    method: 'POST',
    path: '/pages/rename',
    body: RenamePageRequestSchema,
    responses: {
      200: z.object({ page: PageSchema }),
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
      409: PageRevisionErrorSchema,
    },
    summary: 'Rename page',
  },
});
