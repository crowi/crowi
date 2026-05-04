import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  UserPageResponseSchema,
  UserBookmarksResponseSchema,
  UserPagesResponseSchema,
  UserNotFoundErrorSchema,
  PaginationRequestSchema,
} from '../schemas/user';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const c = initContract();

export const userContract = c.router({
  /**
   * Get user page information
   * - Returns user profile with statistics
   * - Includes recent pages and bookmarks for initial display
   */
  getUserPage: {
    method: 'GET',
    path: '/user/:username',
    pathParams: z.object({
      username: z.string(),
    }),
    responses: {
      200: UserPageResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      404: UserNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get user page information',
  },

  /**
   * Get user bookmarks
   * - Returns paginated list of bookmarks for a user
   * - Only returns bookmarks for pages the current user can access
   */
  getUserBookmarks: {
    method: 'GET',
    path: '/user/:username/bookmarks',
    pathParams: z.object({
      username: z.string(),
    }),
    query: PaginationRequestSchema,
    responses: {
      200: UserBookmarksResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      404: UserNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get user bookmarks',
  },

  /**
   * Get user created pages
   * - Returns paginated list of pages created by the user
   * - Only returns pages the current user can access
   */
  getUserPages: {
    method: 'GET',
    path: '/user/:username/pages',
    pathParams: z.object({
      username: z.string(),
    }),
    query: PaginationRequestSchema,
    responses: {
      200: UserPagesResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      404: UserNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get user created pages',
  },
});
