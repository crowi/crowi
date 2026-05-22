/**
 * RFC-0006 Phase 4 Batch 3 — `bookmark` resource ported to
 * `@hono/zod-openapi` route definitions. Four endpoints:
 *
 *   GET    /bookmarks         — fetch bookmark for a page (or null)
 *   GET    /bookmarks/me      — paginated current-user bookmarks
 *   POST   /bookmarks         — add a bookmark
 *   DELETE /bookmarks         — remove a bookmark
 *
 * All endpoints require JWT authentication; the Hono handler applies
 * `createJwtAuth(crowi)` broadly to `/bookmarks/*` so `c.get('user')`
 * is always populated. The legacy semantics are preserved: `addBookmark`
 * returns `{ bookmark: null }` instead of 404 when the page is missing
 * or not granted, and `removeBookmark` returns `{ ok: true }` even when
 * no bookmark existed.
 */
import { createRoute } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';
import {
  AddBookmarkRequestSchema,
  BookmarkResponseSchema,
  GetBookmarkRequestSchema,
  ListMyBookmarksResponseSchema,
  RemoveBookmarkRequestSchema,
  RemoveBookmarkResponseSchema,
} from '../schemas/bookmark';
import { PaginationRequestSchema } from '../schemas/user';

export const getBookmarkRoute = createRoute({
  method: 'get',
  path: '/bookmarks',
  tags: ['bookmark'],
  security: [{ bearerAuth: [] }],
  summary: 'Get bookmark of a page for the current user',
  request: {
    query: GetBookmarkRequestSchema,
  },
  responses: {
    200: {
      description: 'Bookmark for the page (or null when not bookmarked)',
      content: { 'application/json': { schema: BookmarkResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const listMyBookmarksRoute = createRoute({
  method: 'get',
  path: '/bookmarks/me',
  tags: ['bookmark'],
  security: [{ bearerAuth: [] }],
  summary: "List the current user's bookmarks (paginated)",
  request: {
    query: PaginationRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated bookmark list',
      content: { 'application/json': { schema: ListMyBookmarksResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const addBookmarkRoute = createRoute({
  method: 'post',
  path: '/bookmarks',
  tags: ['bookmark'],
  security: [{ bearerAuth: [] }],
  summary: 'Add a bookmark for the current user',
  request: {
    body: {
      content: { 'application/json': { schema: AddBookmarkRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Bookmark created (or null when the page is not accessible)',
      content: { 'application/json': { schema: BookmarkResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const removeBookmarkRoute = createRoute({
  method: 'delete',
  path: '/bookmarks',
  tags: ['bookmark'],
  security: [{ bearerAuth: [] }],
  summary: 'Remove a bookmark for the current user',
  request: {
    body: {
      content: { 'application/json': { schema: RemoveBookmarkRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Bookmark removed (or already absent)',
      content: { 'application/json': { schema: RemoveBookmarkResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const bookmarkRoutes = {
  getBookmarkRoute,
  listMyBookmarksRoute,
  addBookmarkRoute,
  removeBookmarkRoute,
};
