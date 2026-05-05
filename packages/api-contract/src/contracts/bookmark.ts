import { initContract } from '@ts-rest/core';
import {
  GetBookmarkRequestSchema,
  BookmarkResponseSchema,
  ListMyBookmarksResponseSchema,
  AddBookmarkRequestSchema,
  RemoveBookmarkRequestSchema,
  RemoveBookmarkResponseSchema,
  InvalidPageIdErrorSchema,
} from '../schemas/bookmark';
import { PaginationRequestSchema } from '../schemas/user';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const c = initContract();

export const bookmarkContract = c.router({
  /**
   * Get bookmark of a page for the current user
   * - Returns { bookmark: Bookmark | null }
   */
  getBookmark: {
    method: 'GET',
    path: '/bookmarks',
    query: GetBookmarkRequestSchema,
    responses: {
      200: BookmarkResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get bookmark of a page for the current user',
  },

  /**
   * List bookmarks for the current user (paginated)
   */
  listMyBookmarks: {
    method: 'GET',
    path: '/bookmarks/me',
    query: PaginationRequestSchema,
    responses: {
      200: ListMyBookmarksResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: "List the current user's bookmarks (paginated)",
  },

  /**
   * Add a bookmark for the current user
   * - If the target page is not accessible / does not exist, returns { bookmark: null }
   *   (legacy behavior parity with /_api/bookmarks.add)
   */
  addBookmark: {
    method: 'POST',
    path: '/bookmarks',
    body: AddBookmarkRequestSchema,
    responses: {
      200: BookmarkResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Add a bookmark for the current user',
  },

  /**
   * Remove a bookmark for the current user
   */
  removeBookmark: {
    method: 'DELETE',
    path: '/bookmarks',
    body: RemoveBookmarkRequestSchema,
    responses: {
      200: RemoveBookmarkResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Remove a bookmark for the current user',
  },
});
