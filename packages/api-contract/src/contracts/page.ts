import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  GetPageRequestSchema,
  GetPageResponseSchema,
  ListPagesRequestSchema,
  ListPagesResponseSchema,
  CreatePageRequestSchema,
  UpdatePageRequestSchema,
  SetPageGrantRequestSchema,
  RenamePageRequestSchema,
  PageSchema,
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
  PageRevisionErrorSchema,
  SeenPageRequestSchema,
  SeenUsersResponseSchema,
  GetSeenUsersRequestSchema,
  GetWatchStatusRequestSchema,
  SetWatchStatusRequestSchema,
  WatchStatusResponseSchema,
} from '../schemas/page';
import { AuthenticationRequiredErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';

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
   * Update only a page's grant (visibility), without pushing a new
   * revision. Powers the editor's visibility selector — a grant change
   * is a property mutation, not a content edit, so it must not appear
   * in the page history.
   */
  setPageGrant: {
    method: 'PUT',
    path: '/pages/grant',
    body: SetPageGrantRequestSchema,
    responses: {
      200: z.object({ page: PageSchema }),
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      401: AuthenticationRequiredErrorSchema,
      403: PageNotGrantedErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Update page grant (visibility) only',
  },

  /**
   * Mark page as seen by current user
   */
  seenPage: {
    method: 'POST',
    path: '/pages/seen',
    body: SeenPageRequestSchema,
    responses: {
      200: SeenUsersResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Mark page as seen',
  },

  /**
   * Get users who have seen a page (read-only)
   */
  getSeenUsers: {
    method: 'GET',
    path: '/pages/seen-users',
    query: GetSeenUsersRequestSchema,
    responses: {
      200: SeenUsersResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Get users who have seen a page',
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
      400: InvalidPageIdErrorSchema,
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
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Unlike a page',
  },

  /**
   * If the user has an explicit Watcher record, watching reflects status === WATCH.
   * Otherwise the default is derived from page.getNotificationTargetUsers()
   * (creator + comment authors + revision authors), matching legacy
   * /_api/pages.watch.status semantics.
   */
  getWatchStatus: {
    method: 'GET',
    path: '/pages/watch',
    query: GetWatchStatusRequestSchema,
    responses: {
      200: WatchStatusResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Get watch (notification subscription) status for a page',
  },

  /**
   * - watching=true upserts the Watcher with status=WATCH
   * - watching=false upserts the Watcher with status=IGNORE
   *
   * Default-unset state (no Watcher record at all) is not exposed via this
   * 2-state API; clients can only switch between WATCH and IGNORE explicitly.
   */
  setWatchStatus: {
    method: 'PUT',
    path: '/pages/watch',
    body: SetWatchStatusRequestSchema,
    responses: {
      200: WatchStatusResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      404: PageNotFoundErrorSchema,
    },
    summary: 'Set watch (notification subscription) status for a page',
  },

  /**
   * Delete page (soft delete - moves to trash, or completely=true for hard delete)
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
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
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
      400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
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
